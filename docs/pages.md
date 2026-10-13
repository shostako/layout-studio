# スマホから開く URL（GitHub Pages）

アプリはブラウザだけで動くので、GitHub Pages（無料）に置けば決まった URL で開ける。リポは public なので、置いたアプリは誰でも開ける。中に入るのはアプリだけで、案のデータは開いた人のブラウザにしか残らない。

ワークフローの YAML は Claude から置けない（GitHub App に workflows 権限が無い）。最初の 1 回だけ、GitHub の画面で次の 2 つをする。

1. リポの画面で「Add file」→「Create new file」。名前を `.github/workflows/pages.yml` にし、`docs/pages-workflow.yml` の中身を貼って「Commit changes」。`main` は PR でしか入らないので、出てくる画面で新しいブランチと PR を作ってマージする（`ci` が緑になるのを待つ）。
2. リポの「Settings」→「Pages」→「Build and deployment」の「Source」を「GitHub Actions」にする。

その後は `main` に入るたびに配り直される。URL は https://shostako.github.io/layout-studio/ になる。

配りの YAML を変えたいときは、`docs/pages-workflow.yml` を直す PR を Claude が出し、同じ手順でショスタコが写す。
