# layout-studio

工場の設備レイアウトを検討する図面エディタ。ブラウザだけで動く。

仕様は `docs/SPEC.md`、進み具合は `ROADMAP.md`、作り方の決まりは `CLAUDE.md` を見る。

```
npm ci
npm run dev      # 開発サーバー
npm test         # テスト
npm run build    # dist/ に作る
```

## AI から動かす（手元の MCP サーバー）

Claude Code など MCP に対応した AI から、案の JSON ファイル（画面の「保存」で書き出したもの）を読み、配置の指示を確かめて当てられる。アプリは API キーを持たず、AI は利用者自身のものを使う。

```
npm ci
npm run build:mcp   # mcp/dist/server.js ができる
```

Claude Code に登録する（案のファイルを置くフォルダで。`/path/to/layout-studio` はこのリポを置いた場所）:

```
claude mcp add layout-studio -- node /path/to/layout-studio/mcp/dist/server.js
claude mcp list     # layout-studio: ... Connected と出れば使える
```

道具:

| 名前 | すること |
| --- | --- |
| `get_instructions` | 図面の決まり、指示の書き方、設備の種類と寸法を返す |
| `summarize` | 案の一覧と、1 つの案の要約（設備・通路・敷地・つなぎ・注意・次の id）と面積 |
| `check_commands` | 指示の列を当てたらどうなるかを確かめる（ファイルは変えない） |
| `apply_commands` | 確かめてから当て、ファイルに書き戻す。`new_plan` に名前を書くと、元の案を残して写しに当てる |

例: 「layout.json の案に、成形機を 3 台 2000 mm 間隔で縦に並べて取出機を載せ、新しい案『3台縦』にして」。1 つでも断られる指示があれば、どれも当てずにファイルもそのまま。書き換えたファイルは画面の「開く」で読み直す（画面へのその場の反映はまだ）。
