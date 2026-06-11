// Offset calibration: metronome in the VC, tap along, median(tap − tick)
// becomes the stored offset. Typed input and button input have different
// client paths, so taps are bucketed per method and saved separately.
// Crucially this uses the SAME clock formula as the game (SongClock over
// playbackDuration), so every constant delay — audio out, input path, clock
// skew — is captured exactly as the game will see it.

import {
  ActionRowBuilder,
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
import { join } from "node:path";
import { setOffset, getOffsets } from "./store.js";
import { SongClock } from "./clock.js";
import { createPreparedResource } from "./audio.js";
import { ROOT } from "./chart.js";
import { VoiceInput } from "./voicein.js";

// must match scripts/gen-demo-audio.js
const TICKS = 12;
const FIRST_TICK = 1000;
const TICK_INTERVAL = 1000;
const PAIR_WINDOW = 450; // tap must land within this of a tick to count
const MIN_SAMPLES = 4;

const METHOD_LABEL = { typed: "⌨️ 타이핑", button: "🔘 버튼", voice: "🎙 음성" };

export class CalibrationSession {
  constructor({ textChannel, voiceChannel, user, typedInput, onEnd }) {
    this.textChannel = textChannel;
    this.voiceChannel = voiceChannel;
    this.user = user;
    this.acceptsTyped = typedInput;
    this.onEnd = onEnd;
    this.message = null;
    this.connection = null;
    this.voiceIn = null;
    this.clock = new SongClock();
    this.taps = []; // { pos, method }
    this.ended = false;
  }

  components(disabled = false) {
    return [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("rg:cal")
          .setLabel("👏 TAP")
          .setStyle(ButtonStyle.Primary)
          .setDisabled(disabled),
      ),
    ];
  }

  async start() {
    this.connection = joinVoiceChannel({
      channelId: this.voiceChannel.id,
      guildId: this.voiceChannel.guild.id,
      adapterCreator: this.voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: false, // must hear the user's voice taps
    });
    await entersState(this.connection, VoiceConnectionStatus.Ready, 15_000);

    const player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Play },
    });
    this.connection.subscribe(player);

    // voice taps (PTT/clap) are calibrated too — same detector as the game
    this.voiceIn = new VoiceInput(this.connection, (userId, epochMs) => {
      if (userId !== this.user.id) return;
      if (!this.clock.started || this.ended) return;
      this.taps.push({ pos: this.clock.atEpoch(epochMs), method: "voice" });
    });
    this.voiceIn.start();

    const how = this.acceptsTyped
      ? "게임에서 쓸 방식으로 tap하세요 — **타이핑(`1`+엔터) / 버튼 / 🎙PTT·박수** 모두 측정됩니다."
      : "버튼 또는 🎙PTT·박수로 tap하세요.";
    this.message = await this.textChannel.send({
      embeds: [
        new EmbedBuilder()
          .setColor(0x3498db)
          .setTitle("🎚 오프셋 캘리브레이션")
          .setDescription(
            `<@${this.user.id}> — **${TICKS}번의 틱**이 1초 간격으로 들립니다.\n틱이 **들리는 순간** tap! ${how}`,
          ),
      ],
      components: this.components(),
    });

    const resource = createPreparedResource(join(ROOT, "audio", "metronome.wav"));
    this.clock.attach(resource);
    player.once(AudioPlayerStatus.Idle, () => {
      setTimeout(() => this.finish().catch(() => {}), 800);
    });
    player.play(resource);
  }

  recordTap(snowflakeId, method) {
    if (!this.clock.started || this.ended) return;
    this.taps.push({ pos: this.clock.atSnowflake(snowflakeId), method });
  }

  handleTyped(message, _lanes) {
    if (message.author.id !== this.user.id) return;
    this.recordTap(message.id, "typed");
    this.textChannel.messages.delete(message.id).catch(() => {});
  }

  async handleButton(interaction) {
    if (interaction.user.id !== this.user.id) {
      await interaction.reply({
        content: "이 캘리브레이션은 다른 유저의 것입니다. `/calibrate`로 직접 시작하세요.",
        ephemeral: true,
      });
      return;
    }
    this.recordTap(interaction.id, "button");
    await interaction.deferUpdate().catch(() => {});
  }

  async finish() {
    if (this.ended) return;
    this.ended = true;

    // pair each tap to its nearest tick, bucketed by input method
    const buckets = { typed: [], button: [], voice: [] };
    for (const { pos, method } of this.taps) {
      const idx = Math.round((pos - FIRST_TICK) / TICK_INTERVAL);
      if (idx < 0 || idx >= TICKS) continue;
      const delta = pos - (FIRST_TICK + idx * TICK_INTERVAL);
      if (Math.abs(delta) <= PAIR_WINDOW) buckets[method].push(delta);
    }

    const lines = [];
    let savedAny = false;
    for (const [method, deltas] of Object.entries(buckets)) {
      if (deltas.length === 0) continue;
      if (deltas.length < MIN_SAMPLES) {
        lines.push(`${METHOD_LABEL[method]}: 유효 tap ${deltas.length}개 — 부족해서 저장 안 함 (최소 ${MIN_SAMPLES})`);
        continue;
      }
      deltas.sort((a, b) => a - b);
      const median = deltas[Math.floor(deltas.length / 2)];
      const jitter = Math.sqrt(deltas.reduce((s, d) => s + (d - median) ** 2, 0) / deltas.length);
      setOffset(this.user.id, method, median);
      savedAny = true;
      lines.push(
        `${METHOD_LABEL[method]}: **${median > 0 ? "+" : ""}${median.toFixed(0)}ms** 저장 ` +
          `(tap ${deltas.length}개, 지터 ±${jitter.toFixed(0)}ms${jitter > 90 ? " ⚠️ 불안정" : ""})`,
      );
    }

    const embed = new EmbedBuilder()
      .setTitle("🎚 캘리브레이션 결과")
      .setColor(savedAny ? 0x2ecc71 : 0xe74c3c)
      .setDescription(
        lines.length
          ? lines.join("\n") + (savedAny ? "\n\n이제 판정에서 자동 보정됩니다. 바로 `/play`!" : "")
          : "유효한 tap이 없었어요. 다시 `/calibrate` 해주세요.",
      );

    await this.message
      .edit({ embeds: [embed], components: this.components(true) })
      .catch(() => {});
    this.voiceIn?.stop();
    try {
      this.connection?.destroy();
    } catch {}
    this.onEnd?.();
  }
}

export function describeOffset(userId) {
  const o = getOffsets(userId);
  const parts = [];
  for (const [method, label] of Object.entries(METHOD_LABEL)) {
    if (o[method] !== undefined) {
      parts.push(`${label} **${o[method] > 0 ? "+" : ""}${o[method]}ms**`);
    }
  }
  return parts.length
    ? `현재 오프셋 — ${parts.join(" · ")}`
    : "저장된 오프셋이 없습니다. `/calibrate`로 측정을 권장합니다.";
}
