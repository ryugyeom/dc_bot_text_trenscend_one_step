// One running game in one guild.
//
//   join VC → render/cache GIF + pre-encoded opus → post GIF (its first 3s is
//   a baked-in countdown) → start audio timed against the GIF countdown →
//   judge inputs against the playbackDuration clock → periodic UI edits →
//   result card image + records.
//
// Input paths (all active at once):
//   voice  — UDP. PTT key taps / claps / desk taps via speaking-start events
//            and live onset detection on each player's audio stream.
//            VOICE mode collapses the chart to one lane for this.
//   typed  — "1".."4" / "asdf" (+ chords like "13"); message snowflake = hit
//            time; key messages are bulk-deleted on the UI tick.
//   button — fallback (mobile taps).

import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";
import {
  joinVoiceChannel,
  createAudioPlayer,
  entersState,
  VoiceConnectionStatus,
  AudioPlayerStatus,
  NoSubscriberBehavior,
} from "@discordjs/voice";
import { snowflakeToMs } from "./snowflake.js";
import { PlayerState, judgePress, sweepMisses, rank } from "./judge.js";
import { renderProgress, scoreboardLine, judgeBreakdown } from "./render.js";
import { getOffset } from "./store.js";
import { SongClock } from "./clock.js";
import { createPreparedResource } from "./audio.js";
import { ensureChartGif, COUNTDOWN_MS } from "./gif.js";
import { VoiceInput } from "./voicein.js";
import { renderResultCard } from "./resultcard.js";
import { submitRecord } from "./records.js";

const UI_INTERVAL = 1500; // message edit cadence — safely under rate limits
// how much of the GIF countdown to "spend" waiting for clients to load it;
// raise if the GIF runs ahead of the music, lower if it lags behind
const GIF_LOAD_EST = Number(process.env.GIF_LOAD_EST ?? 600);
const ADAPT_GAIN = 0.2; // in-session drift correction (EMA on residual error)
const ADAPT_CLAMP = 90;

const LANE_STYLES = [
  ButtonStyle.Primary,
  ButtonStyle.Success,
  ButtonStyle.Danger,
  ButtonStyle.Secondary,
];

export class GameSession {
  constructor({ chart, chartKey, textChannel, voiceChannel, starter, typedInput, voiceMode, onEnd }) {
    this.chart = chart;
    this.chartKey = chartKey; // records key, e.g. "demo" or "demo.voice"
    this.textChannel = textChannel;
    this.voiceChannel = voiceChannel;
    this.starter = starter;
    this.acceptsTyped = typedInput;
    this.voiceMode = voiceMode;
    this.onEnd = onEnd;

    this.players = new Map(); // userId -> { name, state, adapt }
    this.clock = new SongClock();
    this.gifMessage = null;
    this.message = null;
    this.connection = null;
    this.audioPlayer = null;
    this.voiceIn = null;
    this.timer = null;
    this.pendingDeletes = [];
    this.ended = false;
  }

  laneRows(disabled = false) {
    const row = new ActionRowBuilder();
    for (let i = 0; i < this.chart.lanes; i++) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`rg:lane:${i}`)
          .setLabel(this.voiceMode ? "TAP" : `${i + 1}`)
          .setStyle(LANE_STYLES[i % LANE_STYLES.length])
          .setDisabled(disabled),
      );
    }
    const ctl = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("rg:stop")
        .setLabel("중단")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled),
    );
    return [row, ctl];
  }

  inputHint() {
    if (this.voiceMode) {
      return "🎙 **PTT 탭 / 박수 / 책상 탭**이 입력! (헤드폰 권장) · 타이핑 `1`·버튼도 가능";
    }
    return this.acceptsTyped
      ? "⌨️ `1`~`4` 또는 `asdf` + 엔터 (동시치기: `13`) · 버튼도 가능"
      : "🔘 버튼으로 입력";
  }

  baseEmbed() {
    const lv = this.chart.level ? ` · LV.${this.chart.level}` : "";
    return new EmbedBuilder()
      .setColor(this.voiceMode ? 0x9b59b6 : 0xe91e63)
      .setTitle(`${this.voiceMode ? "🎙" : "🎵"} ${this.chart.title}`)
      .setFooter({ text: `${this.chart.bpm} BPM · ${this.chart.notes.length} NOTES${lv}` })
      .addFields({ name: "입력", value: this.inputHint() });
  }

  async start() {
    // 1) voice first — if this fails there is no game
    this.connection = joinVoiceChannel({
      channelId: this.voiceChannel.id,
      guildId: this.voiceChannel.guild.id,
      adapterCreator: this.voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: !this.voiceMode, // voice mode needs to hear the players
    });
    try {
      await entersState(this.connection, VoiceConnectionStatus.Ready, 15_000);
    } catch {
      this.cleanup();
      throw new Error("보이스 채널 연결에 실패했습니다.");
    }

    // dropped from VC (kicked / region change / network) → end cleanly
    this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await entersState(this.connection, VoiceConnectionStatus.Ready, 5_000);
      } catch {
        if (!this.ended) this.finish(true, "보이스 연결이 끊겨 게임을 중단했어요.");
      }
    });

    this.audioPlayer = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Play },
    });
    this.audioPlayer.on("error", () => {
      if (!this.ended) this.finish(true, "오디오 재생 오류로 중단했어요.");
    });
    this.connection.subscribe(this.audioPlayer);

    if (this.voiceMode) {
      this.voiceIn = new VoiceInput(this.connection, (userId, epochMs) => {
        const member = this.voiceChannel.members.get(userId);
        if (!member || member.user.bot) return;
        this.judgeAtEpoch(member, [0], epochMs, "voice");
      });
      this.voiceIn.start();
    }

    // 2) prepare assets (first run renders the GIF + encodes opus, then cached)
    let gifPath = null;
    try {
      gifPath = ensureChartGif(this.chart, this.chartKey);
    } catch (e) {
      console.error("GIF 렌더 실패 (텍스트 모드로 진행):", e);
    }
    const resource = createPreparedResource(this.chart.audioPath);
    this.clock.attach(resource);

    // 3) GIF goes up; its first 3s is the countdown the players actually watch
    const sentAt = Date.now();
    if (gifPath) {
      try {
        this.gifMessage = await this.textChannel.send({
          files: [new AttachmentBuilder(gifPath, { name: `${this.chartKey}.gif` })],
        });
      } catch (e) {
        console.error("GIF 첨부 실패 (Attach Files 권한?):", e.message);
        gifPath = null;
      }
    }
    this.message = await this.textChannel.send({
      embeds: [
        this.baseEmbed().setDescription(
          gifPath ? "**🎬 GIF 카운트다운에 맞춰 준비!**" : "**준비하세요...**",
        ),
      ],
      components: this.laneRows(),
    });

    // 4) start audio so its t=0 lands where the GIF countdown ends
    const wait = COUNTDOWN_MS - GIF_LOAD_EST - (Date.now() - sentAt);
    if (wait > 0) await sleep(wait);
    if (this.ended) return; // aborted during prep

    const started = new Promise((res) => {
      this.audioPlayer.once(AudioPlayerStatus.Playing, res);
    });
    this.audioPlayer.play(resource);
    await started;

    this.timer = setInterval(() => this.tick().catch(() => {}), UI_INTERVAL);
  }

  getPlayer(user) {
    let p = this.players.get(user.id);
    if (!p) {
      p = {
        id: user.id,
        name: user.displayName ?? user.username,
        state: new PlayerState(this.chart),
        adapt: 0,
      };
      this.players.set(user.id, p);
    }
    return p;
  }

  // Core judgment, shared by all input paths.
  judgeAtEpoch(user, lanes, epochMs, method) {
    if (!this.clock.started || this.ended) return;
    const p = this.getPlayer(user);
    const base = this.clock.atEpoch(epochMs) - getOffset(user.id, method);
    for (const lane of lanes) {
      const res = judgePress(this.chart, p.state, lane, base - p.adapt);
      if (res && res.kind !== "BREAK") {
        // residual error feeds a clamped EMA → absorbs mid-session drift
        p.adapt = clamp(p.adapt + res.deltaMs * ADAPT_GAIN, -ADAPT_CLAMP, ADAPT_CLAMP);
      }
    }
  }

  judgeHit(user, lanes, snowflakeId, method) {
    this.judgeAtEpoch(user, lanes, snowflakeToMs(snowflakeId), method);
  }

  // typed path: message snowflake = hit time; delete the key-spam on next tick
  handleTyped(message, lanes) {
    this.judgeHit(message.author, lanes, message.id, "typed");
    this.pendingDeletes.push(message.id);
  }

  // button path (mobile fallback)
  async handleButton(interaction) {
    const [, kind, laneStr] = interaction.customId.split(":");

    if (kind === "stop") {
      if (interaction.user.id !== this.starter.id) {
        await interaction.reply({ content: "시작한 사람만 중단할 수 있어요.", ephemeral: true });
        return;
      }
      await interaction.deferUpdate().catch(() => {});
      await this.finish(true);
      return;
    }

    // judge first (sync, cheap) — ack afterwards
    this.judgeHit(interaction.user, [Number(laneStr)], interaction.id, "button");
    await interaction.deferUpdate().catch(() => {});
  }

  async flushDeletes() {
    if (this.pendingDeletes.length === 0) return;
    const ids = this.pendingDeletes.splice(0);
    try {
      if (ids.length === 1) await this.textChannel.messages.delete(ids[0]);
      else await this.textChannel.bulkDelete(ids, true);
    } catch {} // missing Manage Messages — keys stay visible, game unaffected
  }

  async tick() {
    if (this.ended) return;
    const pos = this.clock.now();

    for (const p of this.players.values()) sweepMisses(this.chart, p.state, pos);
    await this.flushDeletes();

    if (pos > this.chart.durationMs + 600) {
      await this.finish(false);
      return;
    }

    const embed = this.baseEmbed().setDescription(
      renderProgress(this.chart.durationMs, pos),
    );
    if (this.players.size > 0) {
      embed.addFields({
        name: "스코어보드",
        value: [...this.players.values()]
          .sort((a, b) => b.state.score - a.state.score)
          .slice(0, 8)
          .map((p) => scoreboardLine(p.name, p.state, this.chart.notes.length))
          .join("\n"),
      });
    }
    await this.message.edit({ embeds: [embed] }).catch(() => {});
  }

  async finish(aborted, reason = null) {
    if (this.ended) return;
    this.ended = true;
    clearInterval(this.timer);
    this.voiceIn?.stop();
    await this.flushDeletes();

    if (!aborted) {
      for (const p of this.players.values()) {
        sweepMisses(this.chart, p.state, Infinity);
      }
    }

    const embed = new EmbedBuilder()
      .setColor(aborted ? 0x95a5a6 : 0xf1c40f)
      .setTitle(aborted ? `⏹ ${this.chart.title} — 중단됨` : `🏁 ${this.chart.title} — RESULT`);
    if (reason) embed.setDescription(reason);

    const files = [];
    if (this.players.size === 0) {
      embed.setDescription([reason, "참가자가 없었습니다."].filter(Boolean).join("\n"));
    } else {
      const total = this.chart.notes.length;
      const ranked = [...this.players.values()].sort((a, b) => b.state.score - a.state.score);

      const cardData = ranked.map((p) => {
        const acc = p.state.accuracy(aborted ? p.state.judged : total);
        const newRecord =
          !aborted &&
          submitRecord(this.chartKey, p.id, {
            name: p.name,
            acc: Number(acc.toFixed(2)),
            rank: rank(acc),
            combo: p.state.maxCombo,
          });
        return {
          name: p.name,
          rank: rank(acc),
          acc,
          maxCombo: p.state.maxCombo,
          counts: p.state.counts,
          offsetSamples: p.state.offsetSamples,
          newRecord,
        };
      });

      try {
        files.push(
          new AttachmentBuilder(renderResultCard(this.chart.title, cardData), {
            name: "result.gif",
          }),
        );
      } catch (e) {
        console.error("결과 카드 렌더 실패:", e);
      }

      const blocks = cardData.map((c, i) => {
        const medal = ["🥇", "🥈", "🥉"][i] ?? "▫️";
        const p = ranked[i];
        const avgOff = avg(p.state.offsetSamples);
        const lines = [
          `${medal} **${c.name}** — **${c.rank}** (${c.acc.toFixed(2)}%)${c.newRecord ? " 🆕 신기록!" : ""}`,
          `MAX COMBO **${c.maxCombo}** · ${judgeBreakdown(p.state)}`,
        ];
        if (avgOff !== null && Math.abs(avgOff + p.adapt) > 60) {
          lines.push("평균 타이밍이 치우쳐 있어요 → `/calibrate` 권장");
        }
        return lines.join("\n");
      });
      embed.setDescription([reason, ...blocks].filter(Boolean).join("\n\n"));
    }

    await this.message
      .edit({ embeds: [embed], components: this.laneRows(true), files })
      .catch(() => {});
    this.cleanup();
    this.onEnd?.();
  }

  cleanup() {
    clearInterval(this.timer);
    this.voiceIn?.stop();
    try {
      this.audioPlayer?.stop();
    } catch {}
    try {
      this.connection?.destroy();
    } catch {}
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function avg(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
}
