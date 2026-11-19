# Covens

A coven is a saved team of agents: one leader and the worker roles it hands work to. Each role
names an ordered list of provider and model choices, so a team can mix Codex, Claude and any other
provider you have set up. When a model runs out of quota, the next one in the list takes over.

## Start a coven

Type `/coven-build <what the team should do>` in the composer. T3 Code opens a builder chat on the
current model. The builder asks about the team you want and edits a draft coven while you talk.
The draft shows up under **Coven** in the sidebar: open it to read or change it yourself, and
select **Save coven** when it looks right. `/coven-build edit <name>` starts a builder chat on an
existing coven.

You can also edit a coven directly with `/coven edit [name]`. The editor has four tabs:

- **Roles**: each role, its model chain and its instructions.
- **Governance**: gates, autonomy, limits and the workspace policy.
- **Markdown**: the definition itself. The editor checks it as you type and won't save an invalid
  file.
- **History**: every saved revision. **Restore** loads an old revision; saving it creates a new one.

If the builder changes a draft, or someone saves a newer revision, while you're editing, the editor
merges the two versions. Changes to different parts merge on their own. Where both sides changed
the same lines, you see the two side by side and choose yours, theirs, or both.

A coven is a Markdown file. The front matter holds roles, model chains, gates and limits. The body
holds the mission, shared guidance, and a `## Role: <id>` section for each role.

## Use a coven in a thread

Pick a coven under **Coven** at the bottom of the sidebar (type to search by name, alias or
description), or type `/coven change <name>`. The
thread switches to the leader's model. Choose **No coven**, or type `/coven off`, to go back to a
single agent. Switching covens, or turning the coven off, cancels any work still in flight. Names match by
id, slug, name or alias, and a unique prefix is enough.

In a coven thread, the thread's agent is the leader. A coven stays with its thread until you switch
covens: finishing a piece of work doesn't end it, and the next message continues with the same team.
Its first turn starts the coven's run. If the coven has
`autonomy.initialPlanApproval`, the leader proposes a plan and waits; approve or reject it in the
sidebar or with `/coven approve` and `/coven reject`. The leader then hands work to worker roles.
Each task opens a child thread on the role's first available model, with the role's instructions,
the mission and the run's notes. The generic delegation and thread tools are turned off in coven
threads, so work can't bypass the team's rules.

The sidebar shows the run: its status, the leader's model, one row per task (select a row to open
its thread), anything waiting on you, recent activity, and models that are cooling down.

## When a model runs out

- If a worker's model hits its usage limit, T3 Code marks that model as cooling down until the
  provider's reset time (or for an hour when the provider doesn't say), moves the task's thread to
  the role's next model, and asks it to continue. The leader is told.
- Short failures, such as rate limits or dropped connections, are retried on the same model, up to
  `limits.maxTransientRetriesPerTask` times.
- If the leader runs out, the next leader model takes over with a summary of the plan and open
  tasks, up to `limits.maxLeadershipTransitionsPerRun` times.
- When a task has no model left to try, the run pauses. Resume it once a model is back, or clear a
  cooldown from the sidebar. The leader can't start new work for a role whose models are all
  cooling down.

## Gates

Gates in `governance.gates` decide when the team must stop and check its work:

- `consensus`: the listed roles vote; quorum, majority, k-of-n, unanimity and vetoes are supported.
- `review`: reviewer roles must approve, with an optional minimum number of approvals.
- `test` and `artifact`: a worker submits evidence.
- `human-approval`: you approve in the sidebar or with `/coven approve`.

Before a `before-implementation` gate passes, only the roles that vote on it can be given work. The
leader can't finish the run until its `before-completion` and `before-merge` gates have passed. A
gate that fails `maxRounds` times (default `limits.maxReviewFixRounds`) is sent to you, or pauses the
run, depending on `onUnavailable`.

## Run notes

Each run keeps notes in `docs/coven-runs/<run id>/` in the project: `README.md`, `tasks.md`,
`decisions.md`, `reviews.md`, `handoffs.md` and `activity.md` are rewritten as the run goes.
`memory.md` is created once and never overwritten, so you can add notes there; workers see the
start of it in their briefs. When a project has no folder, the notes go to T3 Code's state
directory instead.

## Commands

| Command                      | What it does                                         |
| ---------------------------- | ---------------------------------------------------- |
| `/coven list`                | Show saved covens.                                   |
| `/coven change <name>`       | Use a coven in this thread.                          |
| `/coven off`                 | Stop using a coven in this thread.                   |
| `/coven show [name]`         | Show a coven's roles and models.                     |
| `/coven status`              | Show the run: status, leader, tasks, what's waiting. |
| `/coven pause`               | Pause the run and interrupt running work.            |
| `/coven resume`              | Continue a paused run.                               |
| `/coven stop`                | Cancel the work in flight. The coven stays.          |
| `/coven delete [name]`       | Delete a coven and take it off every thread.         |
| `/coven approve [note]`      | Approve the plan or gate that is waiting on you.     |
| `/coven reject [note]`       | Reject it.                                           |
| `/coven edit [name]`         | Open the editor.                                     |
| `/coven export [name]`       | Copy the Markdown definition.                        |
| `/coven-build <description>` | Start a builder chat for a new coven.                |
| `/coven-build edit <name>`   | Start a builder chat for an existing coven.          |

## Limits

- `maxActiveWorkers` caps how many tasks run at once, and `maxDelegationsPerRun` caps how many the
  leader can start for one piece of work. The count resets when the leader finishes it.
- With the `hybrid` workspace policy, only one worker writes in the shared checkout at a time;
  others get their own worktree. `isolated-worktrees` gives every worker a worktree.
- A piece of work that goes past `maxRuntimeMinutes` is paused. Idle time doesn't count.
- Saving creates a new revision. A running run keeps the revision it started with.
