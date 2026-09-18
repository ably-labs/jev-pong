# Jev Pong

Pong where the ball moves one step per model decision. Slow model, slow ball.

Jev returns a decision in a couple of hundred milliseconds. The chat models, asked the identical question, take two to four seconds. Four lanes play the same game with a different model on the right paddle: one decision moves the ball one segment, eight segments cross the court, and the model's paddle moves at most one step. Nothing is skipped and nothing is sped up, so a lane's speed is that model's decision latency and nothing else.

Jev is a typed-decision model from TypeSafe AI: a small state goes in, a typed answer comes out. The measured run every number on the site quotes is `public/replay-stats.json`, recorded next to the Gateway by `POST /api/record`.

## What is on the page

- `/` - one line of claim, then four stacked lanes replaying a recorded real run (Jev, Gemini 3.8 Flash, Claude Haiku 4.5, GPT-5.6 Sol, in measured-latency order), then the same four lanes as a results strip. It lists no games and opens no channel. All four lanes restart together at the end of a pass, so they never drift apart. `?clean=1` hides everything except the lanes for screen recording.
- `/how` - why Pong, the rules, what the model sees (the real state, the real question), Jev versus the chat models, where Ably comes in, and the reading order for the code. No channel, no game.
- `/play` - you on the left, Jev on the right, on a court big enough to play on. Arrow keys or W/S, drag on touch. It asks your name once, counts the first serve in, and your game gets a watch link to share.
- `/watch/[id]` - spectate a game from its link, in the same arcade layout as `/play` with nobody's hands on it. Late joiners get the current state immediately. A game is shared, not found in a directory.
- `/arena` - the same four lanes live, each a real worker game. Costs Gateway credit, so it needs the admin token outside local development.

The number of people watching is presence, so it is shown only when somebody is: no viewers means no count, not a zero.

## How it works

Every participant in a game is a member of one Ably channel, `pong:game:{id}`. The human publishes `input` messages and is present as a player. The agent is a Node process that joins the same channel, is present as `agent`, runs the physics, asks Jev for a move, and publishes a `state` snapshot after every decision. Spectators attach with rewind and are present as spectators, so the viewer count is just presence. A second human is one more player on the channel, which is why human vs human needs no extra code.

The agent runs as a Vercel function invocation: `POST /api/game` replies with the game id and keeps the loop alive in the background with `after()` up to the function's `maxDuration`. It ends the game, tells the channel why, and leaves presence when a score reaches five, when the player has been gone for 15 seconds, after 2 minutes with no inputs and no viewers, or 15 seconds before the platform deadline.

Each decision sends Jev a ~125 byte JSON state (ball, paddle, predicted intercept) through Vercel AI Gateway with the AI SDK `experimental_evaluate` API (`typesafe-ai/jev`). The demo lanes on the home page give the identical state and instruction text to chat LLMs through the same Gateway with structured output. Same question, same state, one key.

Browsers authenticate with a short-lived token from `/api/ably-token`. No API key reaches the client.

### What counts as one decision

Every lane gets the same serve, the same rules, and the same question.

The state is a JSON object of numbers - court, ball, paddle, predicted intercept and direction - and nothing else. It is about 125 bytes, and `/how` prints the real one, built by the engine from a served game:

```json
{"court":{"w":160,"h":100},"ball":{"x":80,"y":50,"vx":19,"vy":4.4},"paddle":{"y":50,"h":20},"interceptY":67.4,"dir":"toward"}
```

The question is the instruction text in `DECISION_INSTRUCTIONS` (`lib/decide/prompt.ts`): it states the court semantics and asks for the right paddle to cover `interceptY`, treating the paddle as covering it already when it is within five units. There are three answers - `up`, `down`, `stay` - described by `MOVE_CRITERIA` in the same file. Every lane reads those two constants; nothing is worded twice.

Jev answers through the AI SDK `experimental_evaluate` API. The LLM lanes get the identical state and the identical words through structured output at temperature 0 with reasoning off, and there are no retries for anyone.

The number on a lane is the round trip of that one call, timed on the server, and nothing else.

## Read the code in this order

The code is meant to be read. Eight files, in the order that makes them make sense:

1. `lib/game/types.ts` - the contract. The court, the mechanic (one decision = one tick), and `DecisionState`: the ~125 bytes a model is given.
2. `lib/game/engine.ts` - the whole game, as pure functions. One segment of ball per decision and eight segments per crossing, the paddle planes the ball turns at, and the scripted left paddle that provably never misses.
3. `lib/decide/prompt.ts` - the one question every model is asked, and its three answers. Jev and the chat models read the same words from here.
4. `lib/decide/jev.ts` and `lib/decide/llm.ts` - the two ways that question is put: `experimental_evaluate` for Jev, structured output for the chat models. Both time the model call and nothing else.
5. `lib/worker/game-worker.ts` - the agent as a member of the channel. The decision loop that advances the ball, the 10Hz human paddle, the pacing that makes a game with a human in it playable, and what goes on the wire.
6. `lib/worker/referee.ts` - when a game stops, as a pure state machine with no clock of its own.
7. `app/api/game/route.ts` - one HTTP request, one function, one game.
8. `lib/ably/hooks.ts` - everything a browser does: subscribe to snapshots, be present, publish input. No game logic.

## Jev, briefly

Jev is not a chat LLM. State goes in, a typed Choice, Score or Boolean comes out, with probabilities. No text generation. It is reachable through Vercel AI Gateway with AI SDK 7.0.105 or later. "Cannot hallucinate" means schema-valid, not factually correct. See the [Vercel changelog](https://vercel.com/changelog/typesafe-ai-jev-now-available-on-ai-gateway) and the [evaluate docs](https://ai-sdk.dev/docs/ai-sdk-core/evaluation).

Why Pong: in the Atari-GPT benchmark, Pong was the title LLMs handled worst, below random, because of speed. See [arxiv 2408.15950](https://arxiv.org/html/2408.15950v2).

## Run it

```bash
pnpm install
cp .env.example .env.local   # then fill in the two keys
pnpm dev
```

Environment variables:

| Name | Used by | Notes |
|---|---|---|
| `AI_GATEWAY_API_KEY` | `/api/game` (worker), `/api/record`, `/api/decide` | Vercel AI Gateway key. On Vercel, OIDC works instead. |
| `ABLY_API_KEY` | `/api/ably-token`, `/api/game` | Server only. Mints browser tokens and connects the agent worker. |
| `MAX_LIVE_GAMES` | `/api/game` | Optional cap on concurrent agent workers (default 20). |
| `ADMIN_TOKEN` | `/arena`, `/api/game` demo mode, `/api/record` | Gate for anything that spends credit with nobody playing. Without it those are shut outside `next dev`. Pass as `x-admin-token` or `?token=`. |

When the Gateway budget is exhausted the API returns `out_of_credits` and the lane shows it. No meter, no retries.

```bash
pnpm test          # engine determinism, decide mapping, referee rules, worker lifecycle, token route
pnpm typecheck
pnpm lint
pnpm dlx tsx --env-file=.env.local scripts/record-replay.ts   # re-record public/replay.json from a real run
```

## Stack

Next.js 16 (App Router) on Vercel. `ai` 7 + `@ai-sdk/gateway`. `ably` 2 with `ably/react`. Canvas courts, Tailwind 4. No game engine library.
