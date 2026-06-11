import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  Events,
  SlashCommandBuilder,
  MessageFlags,
} from "discord.js";
import { listCharts, loadChart, toVoiceChart } from "./chart.js";
import { GameSession } from "./session.js";
import { CalibrationSession, describeOffset } from "./calibrate.js";
import { setOffset } from "./store.js";
import { getBoard } from "./records.js";

if (!process.env.DISCORD_TOKEN) {
  console.error("DISCORD_TOKEN이 없습니다. .env.example을 .env로 복사하고 토큰을 넣어주세요.");
  process.exit(1);
}

// one active session (game OR calibration) per guild
const sessions = new Map();

// typed input: "1".."4" or a/s/d/f, up to 4 chars (chord). returns lane array or null
const LANE_KEY = { 1: 0, 2: 1, 3: 2, 4: 3, a: 0, s: 1, d: 2, f: 3 };
function parseLanes(content) {
  const s = content.trim().toLowerCase();
  if (s.length === 0 || s.length > 4 || !/^[1-4asdf]+$/.test(s)) return null;
  return [...new Set([...s].map((c) => LANE_KEY[c]))];
}

const methodChoices = [
  { name: "타이핑", value: "typed" },
  { name: "버튼", value: "button" },
  { name: "음성", value: "voice" },
];

const commands = [
  new SlashCommandBuilder()
    .setName("play")
    .setDescription("리듬게임 시작 (보이스 채널에 먼저 들어가 있어야 해요)")
    .addStringOption((o) =>
      o.setName("chart").setDescription("플레이할 채보").setAutocomplete(true),
    )
    .addStringOption((o) =>
      o
        .setName("mode")
        .setDescription("입력 모드")
        .addChoices(
          { name: "키 (타이핑/버튼, 4레인)", value: "keys" },
          { name: "보이스 (PTT/박수, 1레인)", value: "voice" },
        ),
    ),
  new SlashCommandBuilder().setName("stop").setDescription("진행 중인 게임 중단"),
  new SlashCommandBuilder()
    .setName("calibrate")
    .setDescription("메트로놈으로 개인 입력 지연(오프셋) 측정"),
  new SlashCommandBuilder()
    .setName("offset")
    .setDescription("내 오프셋 확인/수동 설정")
    .addIntegerOption((o) =>
      o.setName("ms").setDescription("수동 설정값 (ms, 비우면 조회만)").setMinValue(-500).setMaxValue(500),
    )
    .addStringOption((o) =>
      o.setName("method").setDescription("어느 입력 방식의 오프셋인지 (기본: typed)").addChoices(...methodChoices),
    ),
  new SlashCommandBuilder()
    .setName("rank")
    .setDescription("채보별 기록 랭킹")
    .addStringOption((o) =>
      o.setName("chart").setDescription("채보").setRequired(true).setAutocomplete(true),
    )
    .addBooleanOption((o) => o.setName("voice").setDescription("보이스 모드 기록 보기")),
  new SlashCommandBuilder().setName("charts").setDescription("채보 목록"),
  new SlashCommandBuilder().setName("help").setDescription("게임 방법"),
].map((c) => c.toJSON());

const HELP = [
  "**DJMAX Discord — 게임 방법**",
  "",
  "1️⃣ 보이스 채널 입장 후 `/calibrate` — 12틱 메트로놈에 맞춰 tap (입력 지연 측정, 최초 1회)",
  "2️⃣ `/play` — GIF 카운트다운 3·2·1을 보고 **음악에 맞춰** 입력",
  "",
  "**입력 방법** (전부 동시에 사용 가능)",
  "· ⌨️ 타이핑: `1`~`4` 또는 `asdf` + 엔터. `13`처럼 묶으면 동시치기",
  "· 🎙 보이스 모드(`/play mode:보이스`): **PTT 키 탭 / 박수 / 책상 탭**이 입력 — UDP라 가장 빠름. 헤드폰 권장",
  "· 🔘 버튼: 모바일용",
  "",
  "**판정** MAX100 ±110ms · MAX90 ±180ms · MAX70 ±260ms · BREAK",
  "**기타** `/rank 채보` 서버 랭킹 · `/offset` 오프셋 확인/수동 조정 · `/stop` 중단",
  "결과의 평균 타이밍이 한쪽으로 치우치면 `/calibrate`를 다시 하세요.",
].join("\n");

// MessageContent is a privileged intent (dev portal toggle). If it's not
// enabled we fall back gracefully: buttons/voice still work, typed input doesn't.
let typedInput = true;

function buildClient(withContent) {
  const intents = [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
  ];
  if (withContent) intents.push(GatewayIntentBits.MessageContent);
  return new Client({ intents });
}

let client = buildClient(true);
wire(client);

try {
  await client.login(process.env.DISCORD_TOKEN);
} catch (e) {
  if (String(e?.message).toLowerCase().includes("disallowed intents")) {
    console.warn(
      "⚠️  Message Content 인텐트가 꺼져 있어 타이핑 입력을 비활성화합니다.\n" +
        "   개발자 포털 → Bot → Privileged Gateway Intents → MESSAGE CONTENT INTENT를 켜면\n" +
        "   키보드 입력(1~4/asdf)이 활성화됩니다. 지금은 버튼/보이스 입력만 동작해요.",
    );
    typedInput = false;
    client.destroy();
    client = buildClient(false);
    wire(client);
    await client.login(process.env.DISCORD_TOKEN);
  } else {
    throw e;
  }
}

// graceful shutdown — finish sessions so result messages aren't left hanging
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    for (const s of sessions.values()) {
      try {
        await s.finish(true, "봇이 종료되어 게임을 중단했어요.");
      } catch {}
    }
    client.destroy();
    process.exit(0);
  });
}

function wire(client) {
  client.once(Events.ClientReady, async (c) => {
    console.log(`로그인: ${c.user.tag} (타이핑 입력: ${typedInput ? "ON" : "OFF"})`);
    if (process.env.GUILD_ID) {
      await c.application.commands.set(commands, process.env.GUILD_ID);
      await c.application.commands.set([]); // clear stale globals → no dupes
      console.log(`길드(${process.env.GUILD_ID}) 커맨드 등록 완료 — 즉시 사용 가능`);
    } else {
      await c.application.commands.set(commands);
      console.log("글로벌 커맨드 등록 완료 — 반영까지 최대 1시간 (GUILD_ID 설정 권장)");
    }
    console.log(
      `초대 링크: https://discord.com/api/oauth2/authorize?client_id=${c.user.id}&permissions=3206144&scope=bot%20applications.commands`,
    );
  });

  // typed input path — keystrokes as messages, snowflake = hit time
  client.on(Events.MessageCreate, (message) => {
    if (message.author.bot || !message.guildId) return;
    const session = sessions.get(message.guildId);
    if (!session?.acceptsTyped || session.ended) return;
    if (message.channelId !== session.textChannel.id) return;
    const lanes = parseLanes(message.content);
    if (!lanes) return;
    try {
      session.handleTyped(message, lanes);
    } catch (err) {
      console.error("typed input 처리 오류:", err);
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isButton()) {
        const session = sessions.get(interaction.guildId);
        if (!session) {
          await interaction
            .reply({ content: "이미 끝난 게임이에요.", flags: MessageFlags.Ephemeral })
            .catch(() => {});
          return;
        }
        await session.handleButton(interaction);
        return;
      }

      if (interaction.isAutocomplete()) {
        const q = interaction.options.getFocused().toLowerCase();
        await interaction.respond(
          listCharts()
            .filter((n) => n.toLowerCase().includes(q))
            .slice(0, 25)
            .map((n) => ({ name: n, value: n })),
        );
        return;
      }

      if (!interaction.isChatInputCommand()) return;

      switch (interaction.commandName) {
        case "help": {
          await interaction.reply({ content: HELP, flags: MessageFlags.Ephemeral });
          return;
        }

        case "charts": {
          const names = listCharts();
          const lines = names.map((n) => {
            try {
              const c = loadChart(n);
              return `· \`${n}\` — ${c.title} (LV.${c.level ?? "?"}, ${c.notes.length}노트, ${c.bpm}BPM)`;
            } catch {
              return `· \`${n}\` — ⚠️ 로드 실패`;
            }
          });
          await interaction.reply({
            content: lines.length
              ? `**채보 목록**\n${lines.join("\n")}`
              : "채보가 없습니다. `npm run gen`으로 데모를 만들어주세요.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        case "rank": {
          const name = interaction.options.getString("chart");
          const voice = interaction.options.getBoolean("voice") ?? false;
          const key = voice ? `${name}.voice` : name;
          const board = getBoard(key);
          if (board.length === 0) {
            await interaction.reply({
              content: `\`${key}\` 기록이 아직 없어요. 첫 기록의 주인공이 되어보세요!`,
              flags: MessageFlags.Ephemeral,
            });
            return;
          }
          const lines = board.map((e, i) => {
            const medal = ["🥇", "🥈", "🥉"][i] ?? `${i + 1}.`;
            return `${medal} **${e.name}** — ${e.rank} ${e.acc.toFixed(2)}% · ${e.combo} COMBO · ${e.date}`;
          });
          await interaction.reply({ content: `**🏆 ${key} 랭킹**\n${lines.join("\n")}` });
          return;
        }

        case "offset": {
          const ms = interaction.options.getInteger("ms");
          if (ms !== null) {
            const method = interaction.options.getString("method") ?? "typed";
            setOffset(interaction.user.id, method, ms);
            await interaction.reply({
              content: `오프셋(${method})을 **${ms > 0 ? "+" : ""}${ms}ms**로 설정했어요.`,
              flags: MessageFlags.Ephemeral,
            });
          } else {
            await interaction.reply({
              content: describeOffset(interaction.user.id),
              flags: MessageFlags.Ephemeral,
            });
          }
          return;
        }

        case "stop": {
          const session = sessions.get(interaction.guildId);
          if (!session) {
            await interaction.reply({ content: "진행 중인 게임이 없어요.", flags: MessageFlags.Ephemeral });
            return;
          }
          await interaction.reply({ content: "게임을 중단합니다.", flags: MessageFlags.Ephemeral });
          await session.finish(true);
          return;
        }

        case "play":
        case "calibrate": {
          if (sessions.has(interaction.guildId)) {
            await interaction.reply({
              content: "이 서버에서 이미 세션이 진행 중이에요. `/stop` 후 다시 시도해주세요.",
              flags: MessageFlags.Ephemeral,
            });
            return;
          }
          const voiceChannel = interaction.member?.voice?.channel;
          if (!voiceChannel) {
            await interaction.reply({
              content: "먼저 보이스 채널에 들어간 다음 명령을 사용해주세요. 🎧",
              flags: MessageFlags.Ephemeral,
            });
            return;
          }

          if (interaction.commandName === "calibrate") {
            const session = new CalibrationSession({
              textChannel: interaction.channel,
              voiceChannel,
              user: interaction.user,
              typedInput,
              onEnd: () => sessions.delete(interaction.guildId),
            });
            sessions.set(interaction.guildId, session);
            await interaction.reply({ content: "캘리브레이션 시작! 🎚", flags: MessageFlags.Ephemeral });
            try {
              await session.start();
            } catch (e) {
              sessions.delete(interaction.guildId);
              await interaction.followUp({ content: `시작 실패: ${e.message}`, flags: MessageFlags.Ephemeral });
            }
            return;
          }

          const chartName = interaction.options.getString("chart") ?? listCharts()[0];
          const voiceMode = (interaction.options.getString("mode") ?? "keys") === "voice";
          let chart;
          try {
            chart = chartName ? loadChart(chartName) : null;
          } catch (e) {
            await interaction.reply({ content: `채보 로드 실패: ${e.message}`, flags: MessageFlags.Ephemeral });
            return;
          }
          if (!chart) {
            await interaction.reply({
              content: "채보를 찾지 못했어요. `npm run gen` 후 `/charts`로 확인해주세요.",
              flags: MessageFlags.Ephemeral,
            });
            return;
          }
          if (voiceMode) chart = toVoiceChart(chart);

          const session = new GameSession({
            chart,
            chartKey: voiceMode ? `${chartName}.voice` : chartName,
            textChannel: interaction.channel,
            voiceChannel,
            starter: interaction.user,
            typedInput,
            voiceMode,
            onEnd: () => sessions.delete(interaction.guildId),
          });
          sessions.set(interaction.guildId, session);
          await interaction.reply({
            content: voiceMode
              ? `**${chart.title}** 시작! 🎙 PTT 탭·박수·책상 탭으로 노트를 치세요. 헤드폰 권장!`
              : `**${chart.title}** 시작! GIF 카운트다운을 보면서, 음악에 맞춰 입력하세요. 🎮`,
            flags: MessageFlags.Ephemeral,
          });
          try {
            await session.start();
          } catch (e) {
            sessions.delete(interaction.guildId);
            await interaction.followUp({ content: `시작 실패: ${e.message}`, flags: MessageFlags.Ephemeral });
          }
          return;
        }
      }
    } catch (err) {
      console.error("interaction 처리 오류:", err);
    }
  });
}
