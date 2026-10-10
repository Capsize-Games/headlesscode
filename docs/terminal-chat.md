# Terminal chat

Run an interactive session with:

```sh
headlesscode chat [--workspace <path>] [--resume <id>] [--model <model>] [--mode <mode>]
```

Each message starts one turn. Enter `"""` on a line by itself to begin a multiline message, then enter it again to submit. A trailing backslash continues a line. The terminal shows the active workspace, session, model, and mode, along with streamed response text and activity supplied by the turn runner. Rendering strips terminal control sequences and limits the amount of streamed text displayed for one turn. `NO_COLOR` and `TERM=dumb` disable ANSI color; redirected input and output use plain text.

The chat command supports these slash commands:

| Command | Action |
| --- | --- |
| `/help` | Show terminal chat commands. |
| `/exit` | Save pending messages and exit. |
| `/new` | Start a new session. |
| `/fork` | Create a session from the current saved history. |
| `/resume <id>` | Resume a session using the currently selected workspace. |
| `/sessions` | List sessions in the current workspace. |
| `/save` | Save pending messages. |
| `/model [name]` | Show or set the model for later turns; `/model default` clears the override. |
| `/mode [name]` | Show or set the mode for later turns. |
| `/skills` | List skills available to this session. |
| `/skill <id>` | Add the activated skill snapshot as context for later turns. |
| `/import <provider> <file>` | Import a conversation as labelled, unverified context. |

Quote file paths with spaces, for example `/import claude "exports/chat.json"`. Prefix a slash command with another slash to send it as a message, such as `//help`.

Ctrl-C aborts an active turn through the runner's abort signal. At the prompt it cancels the current input. Ctrl-D or end-of-file exits; pending messages are saved before exit. The session archive is the source of saved conversation history. Turn failures and save conflicts are reported in the terminal, and a failed save remains available for retry with `/save` while the process stays open.

`/import` creates an archive for the imported conversation and switches to it. The archive keeps its normalized message roles, provenance, and import warnings. Its history is unverified and does not provide runtime approvals or replace the active session's security configuration. Activated skill instructions are added as labelled user context for later turns; they do not run as scripts.
