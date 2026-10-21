"""工場1 に 6 台・工場2 を保管にする案（../20261021-工場1に6台/）の保管場所を、台車を列にまとめて詰めて並べる形に替える。

使い方: python3 gen_f1_dense.py
  このフォルダに外形線だけの平面図 PNG と 一覧.csv を書く。
  BG=背景画像:出力フォルダ を付けると、室内の図面を敷いた版も描く（リポには入れない）。

成形機の並べ方は元の資料の案をそのまま使う（元の gen_f1.main をもう一度走らせて、同じ案を同じ番号で取り出す）。
詰めた並べ方は ../20261021-保管場所-詰め/dense.py。防火壁・開口の前を空けることは元の資料と同じ。元の資料のファイルは変えない。
"""
from __future__ import annotations

import csv
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
LAYOUTS = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(LAYOUTS, '20261021-保管場所-詰め'))
sys.path.insert(0, os.path.join(LAYOUTS, '20261021-工場1に6台'))
import dense as d  # noqa: E402
from dense import gst, gen  # noqa: E402
import gen_f1 as f1  # noqa: E402

N = f1.N


def original_plans():
    cap = []
    draw0, here0 = f1.draw, f1.HERE
    f1.draw = lambda c, path, bg=None: cap.append(c)
    f1.HERE = tempfile.mkdtemp()
    try:
        f1.main()
    finally:
        f1.draw, f1.HERE = draw0, here0
    return cap


def f2_zone(el, ends):
    """工場2 の床を 1 つの区画として列を詰める。開口の前の台車は抜く。両端（片端）の通路がシャッターまでつながるもののうち台数の多いもの"""
    for z in sorted((d.drop(z, f1.APRONS) for z in d.packer(ends)(f1.F2_IN)), key=lambda z: -z['n']):
        if d.reach(f1.agv_ok, el, [z]):
            return d.shrink(z)
    return None


def f1_rest(el, z2, ends):
    """工場1 の残りの床（参考）。成形機からシャッター・開口への道、工場2 の出口からシャッターへの道、開口とシャッターの前を空けて詰める"""
    aisles = [r for k, r, _ in el if k == 'aisle']
    ok2 = f1.agv_ok(el, z2['carts'])
    dE, pE = f1.bfs(ok2, f1.EAST_GOAL)
    dO = [f1.bfs(ok2, oc) for oc in f1.OPEN_CELLS]
    segs = []
    for r in aisles:
        s = f1.nearest(dE, r)
        if s is not None:
            segs += f1.trace(dE, pE, s, True)[0]
        opts = [(dO[k][0][q], k, q) for k in range(2) for q in [f1.nearest(dO[k][0], r)] if q is not None]
        if opts:
            _, k, q = min(opts)
            segs += f1.trace(dO[k][0], dO[k][1], q)[0]
    for e in z2['ends']:
        s = f1.nearest(dE, e)
        if s is not None:
            segs += [r for r in f1.trace(dE, pE, s, True)[0] if r[2] > f1.WALL[0]]
    m = f1.site_mask(f1.WALL_MARGIN + d.GRID / 2) & (d.X > f1.WALL[1] + f1.WALL_MARGIN + d.GRID / 2)
    for k, r, _ in el:
        if k in ('col', 'walk', 'aisle', 'machine', 'part', 'lane'):
            m &= ~f1.rect_mask(r, d.GRID / 2)
    for r in segs + f1.APRONS + [f1.APRON_R]:
        m &= ~f1.rect_mask(r, d.GRID / 2)
    return d.fill(m, d.packer(ends),
                  lambda zs: d.reach(f1.agv_ok, el, zs, fixed_carts=z2['carts'], extra=z2['ends']))


def to_entry(el, z2):
    """成形機の AGV の通路から、工場2 の入口の端の通路までの道のり（mm、いちばん近い通路から）"""
    ok = f1.agv_ok(el, z2['carts'])
    goal = d.np.zeros_like(ok)
    for q in d.gst.center_cells(z2['entry']):
        goal[q] = True
    dist, _ = d.bfs(ok, goal)
    ds = [dist[s] for k, r, _ in el if k == 'aisle' for s in [d.nearest(dist, r)] if s is not None]
    return min(ds) * d.GRID if ds else float('nan')


def walls(ax, box):
    y = d.NOTCH_Y
    for _, (o0, o1) in f1.OPENINGS:
        box((f1.WALL[0], y, f1.WALL[1], o0), fc='#555', ec='none', zorder=3)
        box((f1.WALL[0], o0, f1.WALL[1], o1), fc='#e04040', ec='none', zorder=3)
        y = o1
    box((f1.WALL[0], y, f1.WALL[1], d.SITE_H), fc='#555', ec='none', zorder=3)
    for (nm, (o0, o1)), ar in zip(f1.OPENINGS, f1.APRONS):
        box(ar, fc='none', ec='#e04040', lw=0.6, ls=':', zorder=2.5)
        ax.text(f1.WALL[1] / 1000 + 0.2, o0 / 1000 - 0.25, f'防火シャッター（{nm}）', fontsize=6.5, color='#c03030', va='bottom', zorder=4)
    ax.text(1.0, d.NOTCH_Y / 1000 + 0.3, '工場2', fontsize=9, color='#444', va='top', zorder=4)
    ax.text(f1.WALL[1] / 1000 + 0.3, 0.3, '工場1', fontsize=9, color='#444', va='top', zorder=4)


def main():
    bg_env = os.environ.get('BG', '').split(':') if os.environ.get('BG') else None
    if bg_env:
        os.makedirs(bg_env[1], exist_ok=True)
    rows = []
    for c in original_plans():
        el, no = c['el'], c['no']
        with d.cart_size(**d.RECOUNT):
            rc = f1.evaluate(dict(c), f1.f2_options())
        rc2, rc1 = (rc['carts2'], rc['carts1']) if rc else (0, 0)
        res = {}
        for ends in (2, 1):
            z2 = f2_zone(el, ends)
            zs1 = f1_rest(el, z2, ends) if z2 else []
            res[ends] = (z2, zs1)
        if sum(z['n'] for z in [res[1][0]] + res[1][1] if z) < sum(z['n'] for z in [res[2][0]] + res[2][1] if z):
            res[1] = res[2]      # 両端の並べ方も片端で使える
        z2, zs1 = res[2]
        zones = [z2] + zs1
        route = d.connect(f1.agv_ok, el, zones)
        m_in = to_entry(el, z2)
        n2 = z2['n'] if z2 else 0
        n1 = res[1][0]['n'] if res[1][0] else 0
        r2 = sum(z['n'] for z in zs1)
        r1 = sum(z['n'] for z in res[1][1])
        a2 = gen.union_area([z2['rect']])
        a1 = gen.union_area([res[1][0]['rect']]) if res[1][0] else 0.0
        days = lambda k: k / (N * d.DAILY)  # noqa: E731
        lbl = lambda zi, z: (f"工場2 の保管\n{z['n']} 台" if zi == 1 else f"工場1 の残り\n{z['n']} 台")  # noqa: E731
        title = (f"6 台 案 {no}（詰めた並べ方・列の両端に通路）: {c['structure']}、{gen.PATTERNS[c['pattern']]}、"
                 f"{gen.TYPESET_JA[c['typeset']]}、{d.gs.ROT_JA[c['rot']]}\n"
                 f"工場2 の保管 台車 {n2} 台（{days(n2):.1f} 日分）・{d.tsubo(a2):,.0f} 坪　工場1 の残りに {r2} 台（参考）　"
                 f"元の資料 {c['carts2']} 台、今の並べ方を 1,200 × 1,100 で数え直すと {rc2} 台\n"
                 f"工場2 の列: {d.cols_text([z2], lambda i: '')}　成形機→工場2 の入口 {m_in / 1000:.0f} m、工場2 の出口→シャッター {z2['dist'] / 1000:.0f} m")
        d.draw(c, zones, route, os.path.join(HERE, f'6台_案{no}.png'), title, extra=walls, store_label=lbl)
        if bg_env:
            d.draw(c, zones, route, os.path.join(bg_env[1], f'6台_案{no}.png'), title,
                   (bg_env[0], -609.35, -609.35, 34.82), extra=walls, store_label=lbl)
        pct = lambda k: f'{(k / rc2 - 1) * 100:+.0f}%' if rc2 else ''  # noqa: E731
        rows.append({
            '案': no,
            '工場2 元の資料の台車 台（1,100×900）': c['carts2'],
            '工場2 今の並べ方で数え直し 台（1,200×1,100）': rc2,
            '工場2 両端に通路 台': n2, '両端 増えた割合': pct(n2),
            '工場2 片端に通路 台': n1, '片端 増えた割合': pct(n1),
            '工場2 保管場所 坪（元の資料）': round(c['area2'] / 1e6 / gen.TSUBO, 1),
            '工場2 保管場所 坪（両端）': round(d.tsubo(a2), 1), '工場2 保管場所 坪（片端）': round(d.tsubo(a1), 1),
            '何日分（数え直し）': round(days(rc2), 1), '何日分（両端）': round(days(n2), 1), '何日分（片端）': round(days(n1), 1),
            '工場2 の列の向き（両端）': z2['dir'],
            '列ごとの台数（両端）': d.cols_text([z2], lambda i: '工場2').strip(),
            '列ごとの台数（片端）': d.cols_text([res[1][0]], lambda i: '工場2').strip() if res[1][0] else '',
            '工場1 の残り 元の資料 台': c['carts1'], '工場1 の残り 数え直し 台': rc1,
            '工場1 の残り 両端 台': r2, '工場1 の残り 片端 台': r1,
            '成形機から工場2 の入口 m': round(m_in / 1000, 1),
            '工場2 の出口からシャッター m': round(z2['dist'] / 1000, 1),
        })
        print(no, c['carts2'], rc2, n2, n1, c['carts1'], rc1, r2, r1, round(d.tsubo(a2), 1), z2['dir'], d.cols_text([z2]), flush=True)
    with open(os.path.join(HERE, '一覧.csv'), 'w', newline='', encoding='utf-8-sig') as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    return rows


if __name__ == '__main__':
    main()
