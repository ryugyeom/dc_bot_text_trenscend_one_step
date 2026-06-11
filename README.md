## 텍스트의 한계에서 벗어나보자! 새로운 도전의 첫 걸음.

디스코드 텍스트 베이스 한계에서 벗어나려는 첫 시도로 리듬게임 구현을 구성해봄.


## 핵심 트릭

### 1. 🎙 보이스 수신 = UDP 게임 컨트롤러 (입력의 틈)
버튼·메시지는 결국 HTTP 경로라 한계가 있다. 디스코드에서 유저→봇 방향의 **유일한 UDP 실시간 채널은 보이스 수신**이다.
봇은 이미 보이스 채널에 있고, 유저의 소리는 20ms 간격 RTP 패킷으로 직송된다:

- **PTT(푸시투톡) 키 = 게임 키.** PTT를 누르는 순간 speaking-start 신호가 도착 — 진짜 키보드 키가 리듬 입력이 된다
- **박수 / 책상 탭 / "탁" = 노트.** 유저 오디오 스트림을 실시간 디코드(네이티브 opus)해서 음량 온셋을 검출.
  노이즈 플로어에 적응하는 검출기라 말소리·지속음에는 연사되지 않는다
- 지연 ~30-80ms, 지터는 HTTP 인터랙션보다 훨씬 작다

`/play mode:보이스` — 채보가 1레인으로 병합된 TAP 모드. 헤드폰 권장 (스피커 소리 유입 방지).

### 2. 스노우플레이크 타임스탬프 판정 (정밀도의 틈)
모든 디스코드 ID에는 **서버가 그 객체를 수신한 시각이 ms 단위**로 박혀 있다.
버튼 인터랙션도, 유저가 보낸 메시지도 — 봇까지 오는 지연이 판정에 전혀 끼지 않는다.

```js
hitTime = Number((BigInt(id) >> 22n) + 1420070400000n)
```

### 3. 타이핑 = 키보드 입력 (4레인 기본 입력)
`1`~`4` 또는 `asdf` + 엔터. 메시지 스노우플레이크로 판정하므로 정밀도는 동일하고,
`13`처럼 묶으면 동시치기. 입력 메시지는 매 틱 일괄 삭제. 버튼은 모바일 폴백.

### 4. 보이스 채널 = 게임 클럭 + `playbackDuration` (실시간의 틈)
타이밍 기준은 화면이 아니라 **음악**. 클럭은 벽시계가 아니라 **실제 송출된 오디오량**에 앵커링:

```
판정 위치 = playbackDuration(지금) − (지금 − 입력 수신 시각) − 개인 오프셋
```

송출이 밀리면 클럭도 같이 밀려 드리프트가 자동 보정된다.

### 5. 사전 렌더 GIF 노트 (화면의 틈)
채보 전체를 **떨어지는 노트 GIF**로 미리 렌더해 캐시. GIF 앞 3초에 **READY + 카운트다운 블록**을
구워 넣고, 봇이 그만큼 기다렸다가 음악을 시작해 위상을 맞춘다 (`GIF_LOAD_EST`로 튜닝).
루프 없이 1회 재생, 36초 곡 기준 ~1MB. 판정은 어디까지나 오디오 클럭 — GIF는 "보이는 채보"다.

### 6. 지터 최소화 (송출의 틈)
- 네이티브 opus 인코더/디코더 (`@discordjs/opus`)
- Opus **사전 인코딩** (`cache/*.ogg`) — 재생 중엔 demux만, 20ms 패킷 송출 안정
- `/calibrate` — 메트로놈 12틱으로 고정 지연 측정, **타이핑/버튼/음성 경로별로 따로** 저장
- 플레이 중 잔여 오차 EMA 적응 보정 (±90ms 클램프)

## 완성도 요소

- **결과 카드 이미지**: 픽셀 렌더링된 DJMAX식 결과창 — 랭크 레터(SS~F), 정확도, 맥스 콤보,
  판정 분포 바, **EARLY/LATE 타이밍 히스토그램**, 평균 오차, NEW RECORD 배지
- **기록·랭킹**: 채보별 개인 베스트 영구 저장, `/rank 채보`로 서버 리더보드 (키/보이스 모드 별도)
- **3단계 난이도**: demo-easy (LV.2) / demo (LV.5) / demo-hard (LV.8) — easy ⊂ normal ⊂ hard 부분집합
  설계라 모든 난이도의 노트가 음악에서 들린다
- **즉석 멀티플레이**: 같은 채널 누구든 입력하면 참가, 실시간 스코어보드
- **견고성**: 보이스 끊김 자동 복구/중단, 오디오 오류 처리, GIF 첨부 실패 시 텍스트 폴백,
  Message Content 인텐트 미설정 시 자동 폴백, SIGINT 시 진행 중 게임 정리

## 셋업

폴더 자체에서 터미널로 실행.

```bash
npm install
npm run gen              # 데모 곡 + 채보 3종 + GIF 6종 + opus 사전 생성
copy .env.example .env   # DISCORD_TOKEN, GUILD_ID 채우기 .env에 실데이터 넣기. 파일 직접 복사후 이름 변경(.env.example 복사본 -> .env) 후 데이터 채울 시 해당 명령은 안 써도 됨.
npm start
```

봇 생성: [디스코드 개발자 포털](https://discord.com/developers/applications) → New Application → Bot → 토큰 발급.

> **중요**: Bot → Privileged Gateway Intents → **MESSAGE CONTENT INTENT를 켜야** 타이핑 입력이 동작한다.
> 꺼져 있으면 버튼/보이스 전용 모드로 자동 폴백 (시작 로그에 표시).

초대 링크는 시작 시 콘솔에 출력 (Connect/Speak/Send Messages/Attach Files/Manage Messages).

## 플레이

| 커맨드 | 설명 |
|---|---|
| `/calibrate` | 12틱 메트로놈으로 입력 지연 측정 — 타이핑/버튼/PTT·박수 모두 한 번에 |
| `/play [chart] [mode]` | 게임 시작. mode:보이스 = PTT/박수 1레인 모드 |
| `/rank chart [voice]` | 채보별 서버 랭킹 |
| `/offset [ms] [method]` | 오프셋 조회/수동 미세조정 |
| `/charts` `/stop` `/help` | 목록 / 중단 / 도움말 |

판정: MAX 100% (±110ms) / MAX 90% (±180ms) / MAX 70% (±260ms) / BREAK.

### 싱크 진단
- 판정이 일관되게 늦거나 빠름 → `/calibrate` 재측정 (결과 카드의 히스토그램이 중앙에서 치우쳐 있으면 신호)
- **GIF 화면**만 어긋남 → `.env`의 `GIF_LOAD_EST` 조정 (GIF가 앞서면 ↑, 늦으면 ↓). 판정과 무관

## 채보 만들기

`charts/이름.json`:

```json
{
  "title": "곡 제목",
  "bpm": 120,
  "level": 5,
  "lanes": 4,
  "audio": "audio/파일.wav",
  "durationMs": 36000,
  "notes": [{ "t": 2000, "lane": 0 }, { "t": 2500, "lane": 2 }]
}
```

`t`는 오디오 시작 기준 ms. mp3/ogg/wav 가능 (첫 플레이 때 opus 인코딩+GIF 렌더 후 캐시).
보이스 모드용 1레인 변환은 자동 (120ms 이내 노트 병합).

## 구조

```
src/
  index.js      커맨드/인터랙션/메시지 라우팅, 인텐트 폴백, 종료 처리
  session.js    게임 세션 (보이스 → GIF 카운트다운 → 판정 → 결과 카드)
  voicein.js    🎙 보이스 수신 입력 — speaking 이벤트 + 온셋 검출
  judge.js      판정 엔진 (판정창, 콤보, 랭크, 미스 스윕)
  clock.js      게임 클럭 (playbackDuration 앵커)
  gif.js        채보 → 떨어지는 노트 GIF (카운트다운 내장, 캐시)
  resultcard.js DJMAX식 결과 카드 픽셀 렌더러
  font.js       3×5 비트맵 폰트
  records.js    채보별 베스트 기록
  audio.js      Opus 사전 인코딩
  calibrate.js  오프셋 측정 (3개 입력 경로 동시)
  store.js      유저별·입력방식별 오프셋
  chart.js      채보 로드 + 보이스 모드 변환
  render.js     진행바/스코어보드 텍스트
  snowflake.js  ID → ms
scripts/
  gen-demo-audio.js  데모 곡 + 난이도 3종 채보 + 에셋 사전 빌드
```
