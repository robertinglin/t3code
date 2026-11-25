# Context launchers

Billion Context (`bili`) and pxpipe are optional context-compression tools that can sit between
T3 Code and a coding agent. Install them on the machine that runs your T3 Code server. A remote
client does not need its own copy.

## Install the commands

Both tools need Node.js. Billion Context requires Node.js 22 or newer. Install both CLIs globally:

```bash
npm install -g billion-context pxpipe-proxy --prefix "$HOME/.local"
export PATH="$HOME/.local/bin:$PATH"
```

If you use nvm or Homebrew, or on Windows, omit `--prefix "$HOME/.local"` and use npm's normal
global install location. Make sure that location is on the T3 server process's `PATH`, not just
the terminal where you installed the tools. Check with `bili --version` and `pxpipe --help` from
the server environment.

If T3 cannot find `bili`, enter its full executable path in **Settings > Agent launcher > Bili
executable path**. pxpipe uses the `PATH` of the T3 server process.

## Use Billion Context

In **Settings > Agent launcher**, choose **Billion Context (bili)** to make it the server default
for compatible agents. You can also choose the launcher on an individual provider instance. T3
starts Bili with each agent session; you do not need to start a separate Bili proxy. Use
`bili doctor` in the server environment to inspect its installation.

Bili currently supports Codex, Claude Code, Cline, GLM ACP Agent, Antigravity, OpenCode, and Pi.
The supported ACP Registry agents are Codex, Claude, Antigravity, OpenCode, Pi, and OMP. Other
Registry agents and custom ACP commands cannot use the Bili launcher.

## Use pxpipe

When pxpipe is installed and available on the T3 server's `PATH`, T3 starts its proxy with the
server and stops the proxy when the server shuts down. You do not need to start it in a separate
terminal. It listens on loopback port `47821` by default; its dashboard is at
`http://127.0.0.1:47821/`. T3 launches Gemini CLI through pxpipe by default. Antigravity uses
pxpipe for Google models and Bili for other models by default, restarting its session when you
switch between those model families. In that provider instance's **Agent launcher** setting,
choose **Native** to bypass the model-based launcher.
Open **Usage > Compression** to see pxpipe's token savings and view the Bili and pxpipe dashboards
inline for the selected local environment. The Bili launcher dashboard uses port `18787` while a
Bili-launched agent is running; port `8787` is for a separately started Bili proxy.

If T3 logs that the proxy did not start, check that `pxpipe` is on the server process's `PATH`
and that another service is not already using the proxy port.

## More information

- [Billion Context installation and documentation](https://ranxianglei.github.io/billion-context/docs/)
- [pxpipe installation and documentation](https://github.com/teamchong/pxpipe)
