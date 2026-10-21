"""保管場所の案（../20261021-保管場所/）の保管場所を、台車を列にまとめて詰めて並べる形に替える。

使い方: python3 gen_dense.py
  このフォルダに外形線だけの平面図 PNG と 一覧.csv を書く。
  BG=背景画像:出力フォルダ を付けると、室内の図面を敷いた版も描く（リポには入れない）。
  CACHE=ファイル を付けると、元の案の選び直し（20 分ほど）の結果をそのファイルに残し、次から読む。

成形機の並べ方は元の資料の案をそのまま使う。元の資料の選び方（gen_storage.main）をもう一度走らせて
同じ案を同じ番号で取り出し、保管場所の取り方だけを替える。元の資料のファイルは変えない。
"""
from __future__ import annotations

import csv
import os
import pickle
import sys
import tempfile

import dense as d
from dense import gst, gs, gen

OUT = d.HERE


def original_plans():
    """元の資料の案を、元の番号で返す: [(台数, 番号, 案)]"""
    cache = os.environ.get('CACHE')
    if cache and os.path.exists(cache):
        cap = pickle.load(open(cache, 'rb'))['cap']
    else:
        cap = []
        draw0, here0 = gst.draw, gst.HERE
        gst.draw = lambda c, path, bg=None: cap.append((os.path.basename(path), c))
        gst.HERE = tempfile.mkdtemp()
        bg = os.environ.pop('BG', None)      # 元の main が背景つきの版を描かないように
        try:
            gst.main()
        finally:
            gst.draw, gst.HERE = draw0, here0
            if bg is not None:
                os.environ['BG'] = bg
        if cache:
            pickle.dump(dict(cap=cap), open(cache, 'wb'))
    return [(int(name.split('台')[0]), c['no'], c) for name, c in cap]


def dense_storage(el, route_segs, ends):
    free = gst.free_mask(el, route_segs)
    zones = d.fill(free, d.packer(ends), lambda zs: d.reach(gst.agv_ok, el, zs))
    route = d.connect(gst.agv_ok, el, zones)
    return zones, route


def main():
    bg_env = os.environ.get('BG', '').split(':') if os.environ.get('BG') else None
    if bg_env:
        os.makedirs(bg_env[1], exist_ok=True)
    rows = []
    for n, no, c in original_plans():
        el = c['el']
        segs, _ = gs.route(el)
        with d.cart_size(**d.RECOUNT):
            st = gst.storage(el, segs)
        recount = st[0] if st else 0
        z2, route2 = dense_storage(el, segs, 2)
        z1, _ = dense_storage(el, segs, 1)
        if sum(z['n'] for z in z1) < sum(z['n'] for z in z2):
            z1 = z2      # 両端の並べ方も片端で使える（区画を順に取る手順で片端の方が少なくなったとき）
        n2, n1 = sum(z['n'] for z in z2), sum(z['n'] for z in z1)
        a2 = gen.union_area([z['rect'] for z in z2]) if z2 else 0.0
        a1 = gen.union_area([z['rect'] for z in z1]) if z1 else 0.0
        near = d.near_count(z2)
        z2.sort(key=lambda z: z['dist'])
        days = lambda k: k / (n * d.DAILY)  # noqa: E731
        title = (f"{n} 台 案 {no}（詰めた並べ方・列の両端に通路）: {c['structure']}、{gen.PATTERNS[c['pattern']]}、"
                 f"{gen.TYPESET_JA[c['typeset']]}、{gs.ROT_JA[c['rot']]}\n"
                 f"保管 台車 {n2} 台（{days(n2):.1f} 日分、うちシャッターから 15 m 以内 {near} 台）・保管場所 {d.tsubo(a2):,.0f} 坪　"
                 f"元の資料 {c['carts']} 台、今の並べ方を 1,200 × 1,100 で数え直すと {recount} 台\n"
                 f"列: {d.cols_text(z2)}")
        d.draw(c, z2, route2, os.path.join(OUT, f'{n}台_案{no}.png'), title)
        if bg_env:
            d.draw(c, z2, route2, os.path.join(bg_env[1], f'{n}台_案{no}.png'), title, (bg_env[0], -609.35, -609.35, 34.82))
        pct = lambda k: f'{(k / recount - 1) * 100:+.0f}%' if recount else ''  # noqa: E731
        rows.append({
            '台数': n, '案': no,
            '元の資料の台車 台（1,100×900）': c['carts'],
            '今の並べ方で数え直し 台（1,200×1,100）': recount,
            '両端に通路 台': n2, '両端 増えた割合': pct(n2),
            '片端に通路 台': n1, '片端 増えた割合': pct(n1),
            '保管場所 坪（元の資料）': round(c['store_area'] / 1e6 / gen.TSUBO, 1),
            '保管場所 坪（両端）': round(d.tsubo(a2), 1), '保管場所 坪（片端）': round(d.tsubo(a1), 1),
            '何日分（数え直し）': round(days(recount), 1), '何日分（両端）': round(days(n2), 1), '何日分（片端）': round(days(n1), 1),
            'うちシャッターから15m以内 台（両端）': near,
            'いちばん近い区画の出口からシャッター m': round(z2[0]['dist'] / 1000, 1) if z2 else '',
            '区画数（両端）': len(z2),
            'いちばん長い列 台（両端）': d.deepest(z2), 'いちばん長い列 台（片端）': d.deepest(z1),
            '列ごとの台数（両端）': d.cols_text(z2),
            '列ごとの台数（片端）': d.cols_text(z1),
            '成形機の道と区画の道が重なる区画（両端）': sum(1 for z in z2 if z.get('cross')),
        })
        print(n, no, c['carts'], recount, n2, n1, round(d.tsubo(a2), 1), flush=True)
    with open(os.path.join(OUT, '一覧.csv'), 'w', newline='', encoding='utf-8-sig') as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    return rows


if __name__ == '__main__':
    sys.exit(main() and 0)
