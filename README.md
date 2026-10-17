# conductor

A Claude Code mod that turns the main agent into a conductor. The main chat plans, delegates and talks to you. Subagents do the work, each on the cheapest model that fits. A plan and a knowledge base in the project carry what every agent needs, so no one reloads the whole context.

## How a project runs

1. **Plan.** Ask for something multi-step, or type `/conductor plan <goal>`. An architect writes `.knowledge/plan.md`: phases of tasks, each tagged with its agent, model, dependencies, files and a check, e.g. `- [ ] T4: PDF export {agent: builder, model: haiku, after: T3, files: src/pdf.ts, verify: npm test pdf}`. Ids may be dotted for sub-tasks (`T29.2.1`). A step for you or the main agent (an approval, a decision, a hands-on check) is tagged `agent: main`: runs never dispatch it, the pane marks it "for you / main agent", and the run's end note lists it.
2. **Approve.** The Agents pane shows **Plan ready for review**. You can change any task's agent or model with **edit tasks**, then **approve & run**. You approve a plan once: later edits to it (tasks added or fixed by the agents, same plan title) never stop a run for approval. Only a plan with a new title asks again.
3. **Run.** The conductor starts every task whose dependencies are done, up to 4 at a time. `run_plan` with task ids runs only those; called again with no ids, the run widens to the whole plan. A task ticked done (by an agent's report or by hand) stays done: no late report, verifier or retry reopens it, and only your **retry** does. It writes each task a **brief** (`.knowledge/tasks/T4.md`) holding the goal, files, done-criteria, relevant decisions and the results of the tasks it depends on. Agents read their brief instead of the conversation, and the main agent writes no per-task prompts.
4. **Verify and escalate.** A tagged task is checked by a Haiku verifier, one at a time per task. Verifiers and builders run commands the way `.knowledge/project.md` documents them (its interpreter and tools). A check that cannot run for reasons outside the task (a missing tool or path) is **inconclusive**, not a fail. A task that fails, or fails its check, is retried one model up (Haiku, then Sonnet, then Opus), with what went wrong added to its brief. An agent stopped at twice its tool-call budget counts as a failed try; its brief records the calls, last step and files it touched, so the retry picks up from there. After three tries it's marked blocked.
5. **Ask only when it matters.** Only an urgent question stops work, and only its own task; every other task keeps going. An urgent question is one the agent can't continue without, given your autonomy level. It goes into the **Questions pane**'s **Needs you** queue, and the pane opens by itself (unless it is already open or you closed it). Answer it, pick an offered option, or **let AI decide**. The answer goes into the brief and `decisions.md`, and the task goes back in the queue.
6. **Questions for later.** Anything else an agent wants your view on, it decides itself, notes what it assumed, and keeps going. Those questions collect in the Questions pane's **For later** list. Answer when you like, keep the agent's assumption, or dismiss. An answer goes to `decisions.md` and the task's brief. If it differs from what the agent assumed, the main agent gets a note to add a follow-up task if finished work depends on it.

   **What agents write.** An urgent question is a `NEEDS:` line, an optional `WHY:` line and numbered options (the recommended one marked). A later question is a `Q:` line, an optional `WHY:` line, numbered options and `WENT WITH: <option number>`, one group per question inside the report's `<questions>` block:

   ```
   Q: Should old reports be kept after the upgrade?
   WHY: They take space but cannot be rebuilt.
   1. Keep them: nothing is lost, uses more disk space (recommended)
   2. Delete them: saves space, cannot be undone
   WENT WITH: 1
   ```

   **Plain language.** Every question is written for someone who is not an expert: plain words, what is being decided and what each choice changes in practice, any unavoidable term explained in a few words, and no ids, file paths or code unless you need them to answer. Each option is offered as a suggested answer you can pick with one click.
7. **Finish.** The plan ticks itself. When the run ends, you get a chime and a toast, and the main agent gets a short note.

## What saves usage

| | |
| --- | --- |
| **Delegation** | In `enforce` mode the main agent can't edit project files, so all work goes to subagents with their own context. It can still edit `.knowledge/`. A plan-first gate refuses builder tasks that name no plan task (`Plan item: none` allows a one-off). |
| **Model routing** | Plan tags first. Otherwise a keyword router picks the model, with Haiku breaking ties. The router **learns**: a kind of task that keeps failing on a model moves up a tier for next time, remembered across sessions. A task that failed before starts one tier up. |
| **Effort** | Each subagent thinks only as hard as its job needs: low for scouts, verifiers and the curator, medium for builders, high for architects. |
| **Tool-call budgets** | An agent past its budget (scout 40, builder 120, ...) is told to wrap up, and is stopped at twice the budget. |
| **Briefs and the code map** | Agents get only what their task needs. `map.md` has one line per file, so scouts don't search the whole tree. |
| **Spilled outputs** | A tool output in the main chat longer than 12,000 characters is saved to `.knowledge/session/spill/`. Only its head, its tail and a pointer stay in the conversation, which is re-sent every turn. |
| **Context management** | At 45% context the mod saves a handoff note to `session/handoff.md`. At 65% (or 130k tokens) it compacts. After compaction, `/clear` or a new session, it reloads the index, the plan summary and the handoff. |
| **Knowledge upkeep** | Subagents end reports with `<decisions>` and `<knowledge>` blocks. The mod files them and keeps them out of the main chat. A Haiku curator folds the notes in, updates `map.md` for changed files, and re-checks recorded facts whose source files changed (each fact is tagged `(src: path)`). |
| **Rate limits** | When a rate-limit window passes 85%, new tasks are capped at Sonnet until it eases. |
| **Daily budget** | Optional, counted across sessions. At 90% of it the conductor **wraps up**: it starts nothing new, tells running agents to finish their step and report, writes a handoff, and tells the main agent to wind down. At 100% it pauses the run. It never changes models. |

## What you see

- **Agents pane** (`/conductor pane`, or **agents** in the project bar) shows, from top to bottom:
  - a one-line count of questions waiting with an **open questions** button (the questions themselves are in the Questions pane), and the Couldn't start box;
  - plan review;
  - a context bar with dots at the save and compact points;
  - run controls (pause, resume, stop);
  - the plan by phase, expandable, with who is working on each task, verification and failed tries;
  - running and finished agents, expandable to their step lists, edited files (clickable on desktop) and report summary, with a stop button each.

  Runs open the pane only when it is not open already, and never again after you close it yourself; `/conductor pane` always opens it. When the window is too narrow to place it, the status line and the project bar say "pane hidden", with a **show agents** button. If the pane ever fails to draw, it shows the error and a **reset view** button instead of closing.

  Underneath are the autonomy picker, spend with the estimated savings versus using Opus for everything, and today against your budget. Buttons: expand all (`e`), edit tasks (`t`), checkpoint (`c`), compact (`k`), upkeep (`u`), report (`o`), clear finished (`x`).
- **Questions pane** (`/conductor questions`, or the questions chip in the project bar) holds the **Needs you** queue (urgent) and the **For later** list (questions that block nothing; **dismiss all** clears it without recording anything), each with the agent's why-line, its suggested options and a free-text answer. A new urgent question opens it by itself, and so does a chat that starts with urgent questions already waiting (questions for later alone do not), unless it is already open or you closed it.
- **Project bar** above the prompt shows the plan's progress bar with a dot per task (or per phase), the run state, one questions chip (click it to open the Questions pane; it also shows when only later questions wait), and agents working. Click it, or type `/conductor expand`, to see the current phase's tasks.
- **Welcome-back card**: in a new session, a line such as "12/20 done · blocked: T13 · next up: T14" with **run** and **dismiss** buttons.
- **Bars** are SVG in the desktop app and text in the terminal (`━━━●━━╸◉───○`). Colours follow your theme.
- **Progress report** (`/conductor report`) writes `.knowledge/report.md` and `report.html` from saved data. It makes no model calls.

## Autonomy levels (`/conductor autonomy <level>` or the pane picker)

| Level | Agents stop and ask when |
| --- | --- |
| `ask-all` | any choice the task and brief don't settle |
| `ask-important` (default) | a choice changes scope or a public interface, adds a dependency, deletes or migrates data, touches security or cost, or can't be undone |
| `ask-blocking` | they can't continue without something only you have |
| `decide-all` | never: they decide, log it in `decisions.md`, and flag risks |

## Commands

```
/conductor                     status: mode, context, plan and run, spawns, usage, knowledge
/conductor test                launch one tiny Haiku agent: checks the mod can start its own agents here
/conductor plan <goal>         an architect drafts the plan for your approval
/conductor run [T4 T5]         approve and run the plan (or only those tasks)
/conductor approve | pause | resume | stop
/conductor retry <id>           put a task whose agent could not start back in the queue
/conductor autonomy <level>    ask-all | ask-important | ask-blocking | decide-all
/conductor budget <usd>        daily budget; 0 turns it off
/conductor report              progress report, no model calls
/conductor diag                pane diagnostics (draws, timing, errors, last tree, state) to .knowledge/session/pane-diag.json
/conductor pane | band | expand
/conductor questions           open the Questions pane
/conductor mode enforce|guide|off
/conductor checkpoint | compact | curate | init | route <task>
```

The main agent starts runs with its `run_plan` tool, and subagents report steps with `progress`.

## Settings (`/config`, or `pluginConfigs.conductor.options`)

| Option | Default | |
| --- | --- | --- |
| `delegation` | `enforce` | `enforce` / `guide` / `off` |
| `routing` | `auto` | `auto` (respect an explicit model) / `force` / `off` |
| `topModel` | `opus` | the strongest model it may use |
| `classifier` | `true` | Haiku tie-breaker when the router is unsure |
| `learnRouting` | `true` | move failing kinds of task up a tier |
| `autonomy` | `ask-important` | see above |
| `requireApproval` | `true` | a new plan waits for your approval once; edits to an approved plan don't |
| `requirePlanItem` | `true` | plan-first gate (enforce mode) |
| `approveOwnAgents` | `true` | approve the agents the mod launches itself (see Permissions) |
| `maxParallel` | `4` | tasks a run works on at once |
| `verify` | `tagged` | `tagged` / `always` / `off` |
| `escalate` | `true` | retry failures one tier up |
| `checkpointPercent` / `compactPercent` / `compactTokens` | `45` / `65` / `130000` | context management |
| `spillChars` | `12000` | spill larger outputs |
| `curateEvery` / `mapEvery` | `5` / `8` | upkeep after this many notes / changed files |
| `rateLimitDownshift` | `85` | cap at Sonnet past this rate-limit %; 0 off |
| `dailyBudgetUsd` / `budgetWrapUpPercent` | `0` / `90` | daily budget (API-equivalent dollars) |
| `bootstrapKnowledge` / `showPane` / `sound` | `true` | |

Prices for the savings estimate are per million tokens (input / output / cache read): Opus 5.5 $4 / $20 / $0.20, Sonnet 5.5 $2 / $10 / $0.20, Haiku 4.5 $1 / $5 / $0.10, Fable 5.1 $10 / $50 / $0.25. Cache writes are estimated at 1.25× input.

## Permissions

The agents the conductor launches itself (plan runs, verifiers, upkeep, `/conductor plan`) come from no model request. So auto mode has nothing to judge and refuses them, and other modes would ask you about each one. The mod approves exactly those launches: its own call, of its own agent types (`conductor:*`). Everything else keeps your permission mode, including the main agent's own Agent calls and every tool call the launched agents make. Set `approveOwnAgents` to `false` to have your mode decide each launch instead (in auto mode, mod-launched agents then cannot start).

**When the mod launches agents.** Two rules of the engine decide this:

- A call the mod makes outside its own hooks (from a timer, after its hook returned) skips all of the mod's hooks, including the one that approves its own launches. In auto mode such a launch is refused ("the request that produced this action did not ask for one"); in other modes it would ask you.
- An agent launched from inside a tool call's hook skips that hook for its own tool calls. Its progress reports then go unanswered and its bar stays at 0%.

So the mod launches only at a **launch point**: when an agent's turn ends (where runs mostly launch from), at the end of the main agent's turn, on a `/conductor` command, on a press in the pane, or after a usage measurement. Work that comes due elsewhere (a `run_plan` call, a timer) waits for the next launch point, usually seconds away. If none comes and the main agent is idle, the mod sends it a short prompt to call `run_plan`; its turn's end is then the launch point. Those wake-ups come at most one every 30 seconds.

A launch refused anyway is retried at the next launch point, up to four times, and never counts as an attempt at its task. One that fails for good is written to the task's brief under **Launch problems**, shown in the pane's **Couldn't start** box with **retry** and **dismiss**, and marked `[!]`. `/conductor retry <id>` puts it back in the queue.

## The knowledge base (`.knowledge/`)

```
INDEX.md            one line per file (agents read this first)
project.md · architecture.md · conventions.md    curated facts, each tagged (src: path)
map.md              the code map, one line per file
decisions.md        dated decisions: yours, and the ones agents made
plan.md             the plan; the bars and runs are drawn from it
tasks/<id>.md       each task's brief, answers, result, verification, earlier attempts
session/handoff.md  the latest checkpoint of the main conversation
session/spill/      large outputs cut from the main chat
inbox.md            notes waiting for the curator
report.md/.html     the last progress report
```

## Layout

```
hooks/register.tsx   every hook: routing, runs, questions, budget, spill, the pane and the band
hooks/plan.ts        plan.md: parsing, tags, ready tasks, ticking, approval signature
hooks/briefs.ts      task briefs and results
hooks/route.ts       router, escalation, learning, effort, budgets, prices
hooks/tasks.ts       agents' and the main agent's task lists
hooks/notes.ts       report parsing: STATUS, NEEDS, <decisions>, <knowledge>
hooks/spill.ts       spilling large outputs
hooks/bar.ts         text and SVG bars with checkpoint dots
hooks/draw.tsx       shared drawing pieces
hooks/prompts.ts     every text a model sees
assets/chime.wav     the notification sound
tests/               claude plugin test .
```
