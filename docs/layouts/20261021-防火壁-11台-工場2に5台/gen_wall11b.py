"""防火壁がある前提で、成形機 11 台を工場1 に 6 台・工場2 に 5 台置き、残りの床に製品の保管ストッカーを置く案を作る。

使い方: python3 gen_wall11b.py
  このフォルダに外形線だけの平面図 PNG と 一覧.csv を書く。
  BG=背景画像:出力フォルダ を付けると、室内の図面を敷いた版も描く（リポには入れない）。

../20261021-防火壁-11台/ は反操作側の人の通路を 0.5〜0.6 m に詰めて工場1 に 7 台を入れた。ここでは反操作側の通路は元の 1.0 m のまま、
工場2 に東西向きの 1 列で 5 台を入れる。そのために 2 点を変える。
- 工場2 の AGV の無い端の通路（金型・保守）を 1.5 → 1.3 m にする（東西向きの 1 列の幅 15.45 m が、工場2 の幅 15.3 m に収まる）。工場1 は 1.5 m のまま。
- 防火シャッターは通常の作業中は開けておく。AGV の引込み（AGV が通るだけの所）は、AGV の通路と同じく防火シャッターの前に入ってよい。
  成形機と帯の装置は、元どおり防火シャッターの前に入れない。
防火壁・防火シャッター・部屋ごとの並べ方は ../20261021-防火壁/gen_wall.py、
保管場所は「今の並べ方」（../20261021-保管場所/gen_storage.py、台車 1,200 × 1,100）と
「詰めた並べ方」（../20261021-保管場所-詰め/dense.py）の両方を出す。元の資料のファイルは変えない。
"""
from __future__ import annotations

import csv
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
LAYOUTS = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(LAYOUTS, '20261021-保管場所-詰め'))
sys.path.insert(0, os.path.join(LAYOUTS, '20261021-防火壁'))
import gen_wall as gw  # noqa: E402  （先に読み込んで、保管場所の升目に壁を足す）
import dense as d  # noqa: E402
from dense import gst, gen  # noqa: E402

N = 11
VARIANTS = 8         # 載せる案の数


def dense_storage(el, route_segs, ends):
    free = gst.free_mask(el, route_segs)
    zones = d.fill(free, d.packer(ends), lambda zs: d.reach(gst.agv_ok, el, zs))
    route = d.connect(gst.agv_ok, el, zones)
    return zones, route


def room_ok_fire_lane(el, room, east_lane=False):
    """防火シャッターの前に AGV の引込みが入ってよいとする判定。成形機と装置は元どおり入れない。
    east_lane: 東の電動シャッターの前にも引込みを許すか"""
    for k, r, _ in el:
        if k in gw.gs.FIT_KINDS and not gw.in_room(r, room):
            return False
        if k in ('machine', 'part') and any(gen.overlaps(r, a) for a in gw.APRONS + [gw.EAST_APRON]):
            return False
        if k == 'lane' and not east_lane and gen.overlaps(r, gw.EAST_APRON):
            return False
    return True


W_END_F2 = 1300      # 工場2 の AGV の無い端の通路
# 東の電動シャッターの前に引込みを許すか（許しても結果が同じだったので、許さない版だけを作る）
CONFIGS = [False]


def _set_w_end(v):
    gen.W_END = v
    gw.gs.W_END = v


def layouts():
    """工場1 に 6 台・工場2 に 5 台の組み合わせで、AGV の道が壁の開口を通ってつながるものすべて"""
    out, sig, caps = [], set(), {}
    old_end, old_ok = gen.W_END, gw.room_ok
    try:
        for east_lane in CONFIGS:
            gw.room_ok = lambda el, room, e=east_lane: room_ok_fire_lane(el, room, e)
            _set_w_end(old_end)
            es = gw.room_cands(6, '工場1', keys=12, per_key=6)
            _set_w_end(W_END_F2)
            ws = gw.room_cands(5, '工場2', keys=12, per_key=6)
            _set_w_end(old_end)
            caps[east_lane] = (len(es), len(ws))
            for e in es:
                for w in ws:
                    c = gw.combine(N, e, w)
                    if c is None:
                        continue
                    q = (east_lane, round(c['occ'] / 1e5), round(c['agv_len'] / 100), ''.join(u.t for u in c['meta']['units']))
                    if q in sig:
                        continue
                    sig.add(q)
                    c['split'] = (6, 5)
                    c['nonop'], c['lane'] = gen.W_MACHINE, east_lane
                    out.append(c)
    finally:
        _set_w_end(old_end)
        gw.room_ok = old_ok
    return caps, out


def evaluate(c):
    el = c['el']
    with d.cart_size(**d.RECOUNT):
        gw.add_storage(c)            # 今の並べ方（台車 1,200 × 1,100、通路の両側に 1 台ずつ）
    c['z2'], c['route2'] = dense_storage(el, c['route'], 2)
    z1, _ = dense_storage(el, c['route'], 1)
    if sum(z['n'] for z in z1) < sum(z['n'] for z in c['z2']):
        z1 = c['z2']
    c['z1'] = z1
    c['n2'] = sum(z['n'] for z in c['z2'])
    c['n1'] = sum(z['n'] for z in z1)
    c['a2'] = gen.union_area([z['rect'] for z in c['z2']]) if c['z2'] else 0.0
    c['z2'].sort(key=lambda z: z['dist'])
    return c


def pick(cs):
    """詰めた並べ方の台数の多い順に、工場1・工場2 の並べ方が違うものを選ぶ。
    同じ形なら反操作側の通路の広い方（0.6 m）を採る。東のシャッターの前を元のまま空けた案の最良も必ず入れる"""
    key = lambda c: (-c['n2'], -c['carts'], c['occ'])  # noqa: E731
    cs = sorted(cs, key=key)
    out, seen = [], set()
    for c in cs:
        e, w = c['parts']
        k = (c['lane'], w['structure'], w['pattern'], w['rot'] % 2, e['rot'])
        if k not in seen:
            seen.add(k)
            out.append(c)
        if len(out) >= VARIANTS - 1:
            break
    strict = [c for c in cs if not c['lane']]
    if strict and not any(not c['lane'] for c in out):
        out.append(strict[0])
    return out


def main():
    bg_env = os.environ.get('BG', '').split(':') if os.environ.get('BG') else None
    if bg_env:
        os.makedirs(bg_env[1], exist_ok=True)
    bgv = (bg_env[0], -609.35, -609.35, 34.82) if bg_env else None
    cap, cs = layouts()
    print('capacity', cap, 'layouts', len(cs), flush=True)  # cap は条件ごと
    for c in cs:
        evaluate(c)
    out = pick(cs)
    rows = []
    days = lambda k: k / (N * d.DAILY)  # noqa: E731
    for no, c in enumerate(out, 1):
        desc = '\n'.join(gw.describe(p) for p in c['parts'])
        cond = '工場1 に 6 台・工場2 に 5 台' + ('、東のシャッターの前に引込み' if c['lane'] else '')
        head = f'11 台 案 {no}（{cond}、太い灰: 防火壁）'
        # 今の並べ方
        c['title'] = f'{head}・保管は今の並べ方（台車 1,200 × 1,100、通路の両側に 1 台ずつ）\n{desc}'
        gw.draw(c, os.path.join(HERE, f'11台_6+5_案{no}_今の並べ方.png'))
        if bgv:
            gw.draw(c, os.path.join(bg_env[1], f'11台_6+5_案{no}_今の並べ方.png'), bgv)
        # 詰めた並べ方
        title = (f'{head}・保管は詰めた並べ方（列の両端に通路）\n{desc}\n'
                 f"保管 台車 {c['n2']} 台（{days(c['n2']):.1f} 日分）・保管場所 {d.tsubo(c['a2']):,.0f} 坪　"
                 f"今の並べ方では {c['carts']} 台\n列: {d.cols_text(c['z2'])}")
        dc = dict(c)
        dc['el'] = c['el'] + gw.wall_elements()
        d.draw(dc, c['z2'], c['route2'], os.path.join(HERE, f'11台_6+5_案{no}_詰め.png'), title)
        if bgv:
            d.draw(dc, c['z2'], c['route2'], os.path.join(bg_env[1], f'11台_6+5_案{no}_詰め.png'), title, bgv)
        occ = c['occ'] / 1e6
        pct = (f"{(c['n2'] / c['carts'] - 1) * 100:+.0f}%" if c['carts'] else '')
        rows.append({
            '案': no, '東のシャッターの前に引込み': 'あり' if c['lane'] else 'なし',
            '工場1 台': 6, '工場2 台': 5,
            '並べ方': '＋'.join(gw.describe(p) for p in c['parts']), '型の並び': ''.join(u.t for u in c['meta']['units']),
            '占有 坪': round(occ / gen.TSUBO, 1), '1台あたり 坪': round(occ / gen.TSUBO / N, 2),
            'AGV 通路 m': round(c['agv_len'] / 1000, 1), 'うちシャッターまで m': round(c['route_len'] / 1000, 1),
            '通る防火シャッター': '・'.join('北' if i == 0 else '南' for i in c['doors']) or 'なし',
            '今の並べ方 台': c['carts'], '今の並べ方 保管場所 坪': round(c['store_area'] / 1e6 / gen.TSUBO, 1),
            '詰め（両端に通路）台': c['n2'], '詰め 増えた割合': pct, '詰め（片端に通路）台': c['n1'],
            '詰め 保管場所 坪': round(d.tsubo(c['a2']), 1),
            '何日分（今）': round(days(c['carts']), 1), '何日分（詰め両端）': round(days(c['n2']), 1),
            '何日分（詰め片端）': round(days(c['n1']), 1),
            'いちばん近い区画からシャッター m（詰め）': round(c['z2'][0]['dist'] / 1000, 1) if c['z2'] else '',
            '区画数（詰め）': len(c['z2']), 'いちばん長い列 台（詰め）': d.deepest(c['z2']),
            '列ごとの台数（詰め）': d.cols_text(c['z2']),
            '人とAGVの交差': c['meta']['crossings'],
            '気になる点': ' / '.join(['工場2 の AGV の無い端の通路が 1.3 m（元は 1.5 m）', '工場2 の端の成形機の AGV の引込みが防火シャッターの前にかかる（AGV が通るだけ。台車は止めない）']
                                     + (['東のシャッターの前の通路に引込みが面する（その台車の出し入れ中はシャッターの前がふさがる）'] if c['lane'] else [])
                                     + gw.concerns(c)),
        })
        print(no, c['lane'], round(occ / gen.TSUBO, 1), c['carts'], c['n2'], c['n1'], round(c['route_len'] / 1000), flush=True)
    with open(os.path.join(HERE, '一覧.csv'), 'w', newline='', encoding='utf-8-sig') as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    return rows


if __name__ == '__main__':
    main()
