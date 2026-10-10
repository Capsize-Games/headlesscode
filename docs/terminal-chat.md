# Terminal chat

Run an interactive session with:

```sh
headlesscode chat [--workspace <path>] [--resume <id>] [--model <model>] [--mode <mode>]
```

Each message starts one turn. Enter `"""` on a line by itself to begin a multiline message, then enter it again to submit. A trailing backslash continues a line. Messages are limited to 50,000 characters. The terminal shows the active workspace, session, model, and mode, along with streamed response text and activity supplied by the turn runner. Rendering strips terminal control sequences and limits displayed turn text and activity. `NO_COLOR` or `TERM=dumb` disables ANSI color; non-terminal input or output also uses plain text. The mode's configured model is used unless `--model` or `/model <name>` selects an override; `/model default` clears it.

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
| `/import <provider> <file>` | Create a session from a Claude, Codex, or Muse export and switch to it. |

Quote file paths with spaces, for example `/import claude "exports/chat.json"`. Prefix a slash command with another slash to send it as a message, such as `//help`.

Ctrl-C aborts an active turn through the runner's abort signal. At the prompt it cancels the current input. Ctrl-D or end-of-file exits; pending messages are saved before exit. The session archive is the source of saved conversation history. Turn failures and save errors are shown in the terminal. A revision conflict keeps the turn pending and requires an explicit `/save` retry. An input backlog above the safety limit is discarded with an error, and chat exits so it cannot interpret a partial paste as complete input.

`/import` creates an archive for the imported conversation and switches to it. The archive keeps its normalized message roles, provenance, and import warnings. Its history is unverified and does not provide runtime approvals or replace the active session's security configuration. Activated skill instructions are added as labelled user context for later turns; they do not run as scripts.
