"""工場1 と工場2 の間の仕切り（防火壁）があるものとして、成形機 5〜11 台を並べる案を作る。

使い方: python3 gen_wall.py
  このフォルダに外形線だけの平面図 PNG と 一覧.csv を書く。
  BG=背景画像:出力フォルダ を付けると、室内の図面を敷いた版も描く（リポには入れない）。

成形機 1 台分の帯（A〜D）と列の組み方は ../20261021/gen.py・gen_site.py、
保管場所の取り方は ../20261021-保管場所/gen_storage.py をそのまま使う。
ここで足すのは、防火壁と防火シャッター（壁を越えられるのはその開口だけ）と、
工場1・工場2 それぞれに列を収めて組み合わせることだけ。
"""
from __future__ import annotations

import csv
import itertools
import math
import os
import re
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
LAYOUTS = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(LAYOUTS, '20261021'))
sys.path.insert(0, os.path.join(LAYOUTS, '20261021-保管場所'))
import gen  # noqa: E402
import gen_site as gs  # noqa: E402
import gen_storage as gst  # noqa: E402
from gen import AISLE, TSUBO, PATTERNS, TYPESET_JA  # noqa: E402
from gen_site import SITE_W, SITE_H, NOTCH_Y, SITE_AREA, ROT_JA  # noqa: E402

# ---- 防火壁と開口（敷地の座標、mm）----
# 壁の中心は工場2 の東の壁の線（x = 15.5 m）。壁の厚みと東側に出る柱の出っ張りを合わせて、
# x 15.3〜16.2 m を物を置けない帯とする（図面で柱は壁の東側に約 0.7 m 出ている）
WALL = (15300, 16200)
FIRE_DOORS = [(7400, 10600), (38900, 42200)]   # 防火シャッターの開口（y の範囲、W3,200）。北と南
DOOR_APRON = 2500                              # 防火シャッターの両側に空けておく奥行（シャッターの幅の上下 0.5 m も）
ROOMS = {
    '工場1': (WALL[1], 0, SITE_W, SITE_H),       # 東。19.3 × 45.7 m
    '工場2': (0, NOTCH_Y, WALL[0], SITE_H),      # 西。15.3 × 39.3 m
}
WALL_RECTS = []
_y = 0
for d0, d1 in FIRE_DOORS:
    WALL_RECTS.append((WALL[0], max(_y, 0), WALL[1], d0))
    _y = d1
WALL_RECTS.append((WALL[0], _y, WALL[1], SITE_H))
DOOR_RECTS = [(WALL[0], d0, WALL[1], d1) for d0, d1 in FIRE_DOORS]
APRONS = [(WALL[0] - DOOR_APRON, d0 - 500, WALL[1] + DOOR_APRON, d1 + 500) for d0, d1 in FIRE_DOORS]
EAST_APRON = gst.APRON_R

# 保管場所・AGV の道を探す升目に、防火壁を足す（開口だけ通れる）
_site_mask = gst.site_mask


def _wall_mask(m):
    X, Y = gst.X, gst.Y
    w = (X > WALL[0] - m) & (X < WALL[1] + m)
    for d0, d1 in FIRE_DOORS:
        w &= ~((Y >= d0 + m) & (Y <= d1 - m))
    return w


def site_mask(m):
    return _site_mask(m) & ~_wall_mask(m)


gst.site_mask = site_mask
_free_mask = gst.free_mask


def free_mask(el, extra=()):
    """保管場所は、壁の帯と防火シャッターの前にも置かない"""
    m = _free_mask(el, list(extra) + APRONS + DOOR_RECTS)
    for r in WALL_RECTS:
        m &= ~gst.rect_mask(r, WALL_MARGIN_STORE)
    return m


WALL_MARGIN_STORE = gst.WALL_MARGIN + gst.GRID / 2
gst.free_mask = free_mask

KEEP_CLEAR = ('machine', 'part', 'lane')   # 開口の前に入れない物（人の通路・AGV の通路は入ってよい）


def in_room(r, room, eps=1e-6):
    return r[0] >= room[0] - eps and r[1] >= room[1] - eps and r[2] <= room[2] + eps and r[3] <= room[3] + eps


def room_ok(el, room):
    for k, r, _ in el:
        if k in gs.FIT_KINDS and not in_room(r, room):
            return False
        if k in KEEP_CLEAR and any(gen.overlaps(r, a) for a in APRONS + [EAST_APRON]):
            return False
    return True


def room_cands(k, rname, keys=6, per_key=3):
    """部屋 rname に k 台を収める並べ方。組み方・積み方・型・向きごとに、占有の小さい方から keys 通り、
    それぞれ置き場所（部屋の 4 隅と、縦横の中ほど）を per_key 通りまで"""
    room = ROOMS[rname]
    groups = {}
    for sname, spec in gs.specs(k):
        for p in PATTERNS:
            for ts in gs.TYPESETS:
                el0, meta = gs.assemble(k, spec, p, ts, [0] * len(spec))
                if gs.gen_warn(el0):
                    continue
                occ0 = gs.occupied(el0)
                for rot in range(4):
                    el1 = gs.transform(el0, rot)
                    b = gs.bbox(el1)
                    w, h = b[2] - b[0], b[3] - b[1]
                    if w > room[2] - room[0] or h > room[3] - room[1]:
                        continue
                    # 部屋の隅と中ほど、開口の前・東のシャッターの前を避ける位置
                    xs = {room[0], room[2] - w, (room[0] + room[2] - w) // 2,
                          APRONS[0][2], EAST_APRON[0] - w}
                    ys = {room[1], room[3] - h, (room[1] + room[3] - h) // 2}
                    for a in APRONS + [EAST_APRON]:
                        ys |= {a[3], a[1] - h}
                    xs = sorted(x for x in xs if room[0] <= x <= room[2] - w)
                    ys = sorted(round(y / 100) * 100 for y in ys if room[1] <= y <= room[3] - h)
                    for tx, ty in itertools.product(xs, ys):
                        el = gs.transform(el0, rot, tx, ty)
                        if room_ok(el, room):
                            key = (sname, p, ts, rot % 2)
                            groups.setdefault(key, []).append(dict(
                                k=k, room=rname, structure=sname, spec=spec, pattern=p, typeset=ts, rot=rot,
                                tx=tx, ty=ty, el=el, meta=meta, occ0=occ0))
    ks = sorted(groups, key=lambda q: groups[q][0]['occ0'])
    # 型の違いだけの重複を減らす: 組み方・積み方・向きごとに 2 つまで
    out, seen = [], {}
    for q in ks:
        kk = (q[0], q[1], q[3])
        if seen.get(kk, 0) >= 2:
            continue
        seen[kk] = seen.get(kk, 0) + 1
        out.extend(groups[q][:per_key])
        if len(seen) >= keys and sum(seen.values()) >= keys:
            break
    return out


def renumber(el, start):
    out = []
    for k, r, extra in el:
        if k == 'label':
            extra = re.sub(r'^(\d+)', lambda m: str(int(m.group(1)) + start), extra)
        elif k == 'machine':
            extra = extra + start
        elif k == 'part':
            extra = (extra[0], extra[1] + start)
        out.append([k, r, extra])
    return out


def agv_route(el):
    """すべての AGV の通路から東のシャッターまで、壁は開口だけを通る道。つながらなければ None"""
    ok = gst.agv_ok(el, [])
    dist, par = gst.bfs(ok)
    starts = []
    for k, r, _ in el:
        if k == 'aisle':
            s = gst.nearest(dist, r)
            if s is None:
                return None
            starts.append(s)
    return gst.trace(dist, par, starts)


def through_doors(segs):
    return [i for i, (d0, d1) in enumerate(FIRE_DOORS)
            if any(s[0] < WALL[1] and s[2] > WALL[0] and s[1] < d1 and s[3] > d0 for s in segs)]


def describe(c):
    a = f"{c['structure']}、{PATTERNS[c['pattern']]}、{TYPESET_JA[c['typeset']]}、{ROT_JA[c['rot']]}"
    return f"{c['room']} {c['k']} 台（{a}）"


def combine(n, e, w):
    """工場1 の並べ方 e と工場2 の並べ方 w（どちらか None）を合わせて評価する"""
    parts = [x for x in (e, w) if x is not None]
    el, units, crossings, start = [], [], 0, 0
    for p in parts:
        el += renumber(p['el'], start)
        units += p['meta']['units']
        crossings += p['meta']['crossings']
        start += p['k']
    r = agv_route(el)
    if r is None:
        return None
    segs, rlen = r
    c = dict(n=n, el=el, parts=parts, meta=dict(units=units, crossings=crossings),
             route=segs, route_len=rlen, doors=through_doors(segs))
    c['occ'] = gs.occupied(el, segs)
    c['agv_len'] = gs.aisle_len(el) + rlen
    return c


def add_storage(c):
    st = gst.storage(c['el'], c['route'])
    if st is None:
        c.update(zones=[], carts=0, near=0, main_dist=float('nan'), store_area=0.0, zroute=[])
        c['used'] = c['occ']
        return c
    nc, zones, (rsegs, zsegs, rlen, zdist) = st
    for z, d in zip(zones, zdist):
        z['dist'] = d
    zones.sort(key=lambda z: z['dist'])
    sx, sy = SITE_W, sum(gs.SHUTTER) / 2
    c.update(zones=zones, carts=nc, zroute=zsegs, store_area=gen.union_area([z['rect'] for z in zones]),
             main_dist=min(z['dist'] for z in zones),
             near=sum(1 for z in zones for q in z['carts']
                      if math.hypot((q[0] + q[2]) / 2 - sx, (q[1] + q[3]) / 2 - sy) <= gst.NEAR))
    c['used'] = gs.occupied(c['el'], c['route'] + zsegs + [z['rect'] for z in zones])
    return c


def wall_elements():
    el = [['part', r, ('#555555', -1)] for r in WALL_RECTS]
    el += [['lane', a, None] for a in APRONS]
    return el


def draw(c, path, bg=None):
    d = dict(c)
    d['el'] = c['el'] + wall_elements()
    d['route'] = c['route'] + c.get('zroute', [])
    if not c['zones']:
        d['main_dist'] = 0.0
    gst.draw(d, path, bg)


def concerns(c):
    lines = []
    if c['doors']:
        lines.append('AGV が防火シャッターの開口（' + '・'.join('北' if i == 0 else '南' for i in c['doors']) +
                     '）を通る。火災のときはシャッターが閉まるので、その下に物を置かない・AGV を止めない')
    us = c['meta']['units']
    nop = sum(1 for u in us if u.op_band())
    lines.append('全台、操作側に帯' if nop == len(us) else ('全台、操作側が空く' if nop == 0 else f'{nop} 台は操作側に帯'))
    lines.append(f"人の横の通路が AGV の通路を {c['meta']['crossings']} か所で横切る")
    if not c['zones']:
        lines.append('保管の区画が取れない')
    return lines


def main():
    bg_env = os.environ.get('BG', '').split(':') if os.environ.get('BG') else None
    if bg_env:
        os.makedirs(bg_env[1], exist_ok=True)
    counts = [int(a) for a in os.environ.get('ONLY', '5,6,9,10,11').split(',')]
    cache = {}

    def rc(k, room):  # noqa: E306
        if (k, room) not in cache:
            cache[(k, room)] = room_cands(k, room) if k > 0 else [None]
        return cache[(k, room)]

    # 部屋ごとの最大の台数
    cap = {}
    for room in ROOMS:
        k = 1
        while rc(k, room):
            k += 1
        cap[room] = k - 1
    print('capacity', cap, flush=True)
    rows, nores = [], []
    for n in counts:
        ev = []
        for kw in range(0, min(n, cap['工場2']) + 1):
            ke = n - kw
            if ke > cap['工場1'] or ke < 0:
                continue
            if ke == 0 and kw == 0:
                continue
            for e in rc(ke, '工場1'):
                for w in rc(kw, '工場2'):
                    c = combine(n, e, w)
                    if c is not None:
                        c['split'] = (ke, kw)
                        ev.append(c)
        if not ev:
            nores.append(n)
            print(n, 'none', flush=True)
            continue
        # 分け方・組み方ごとに最良 1 つ（占有が小さく、道が短い）
        best = {}
        for c in ev:
            key = (c['split'],) + tuple((p['room'], p['structure'], p['pattern'], p['rot'] % 2) for p in c['parts'])
            kk = (round(c['occ'] / 1e6), c['route_len'])
            if key not in best or kk < best[key][0]:
                best[key] = (kk, c)
        cs = sorted((v[1] for v in best.values()), key=lambda c: (round(c['occ'] / 1e6), c['agv_len']))
        # 1 台だけの列は積み方が効かないので、同じ形の重複を落とす
        uniq, sig = [], set()
        for c in cs:
            q = (c['split'], round(c['occ'] / 1e5), round(c['agv_len'] / 100), ''.join(u.t for u in c['meta']['units']))
            if q not in sig:
                sig.add(q)
                uniq.append(c)
        cs = uniq
        # 分け方ごとに上位 3 つまで、全体で 10 案まで
        out, per = [], {}
        for c in cs:
            if per.get(c['split'], 0) >= 3:
                continue
            per[c['split']] = per.get(c['split'], 0) + 1
            out.append(c)
            if len(out) >= 10:
                break
        for c in out:
            add_storage(c)
        print(n, len(ev), [(c['split'], round(c['occ'] / 1e6), c['carts']) for c in out], flush=True)
        for no, c in enumerate(out, 1):
            c['no'] = no
            desc = '＋'.join(describe(p) for p in c['parts'])
            c['title'] = f"{n} 台 案 {no}（太い灰: 防火壁、緑の破線: 防火シャッターの前の空き）\n" + '\n'.join(describe(p) for p in c['parts'])
            draw(c, os.path.join(HERE, f'{n}台_案{no}.png'))
            if bg_env:
                draw(c, os.path.join(bg_env[1], f'{n}台_案{no}.png'), (bg_env[0], -609.35, -609.35, 34.82))
            occ = c['occ'] / 1e6
            sa = c['store_area'] / 1e6
            rows.append({
                '台数': n, '案': no, '工場1 台': c['split'][0], '工場2 台': c['split'][1],
                '並べ方': desc, '型の並び': ''.join(u.t for u in c['meta']['units']),
                '占有 m2': round(occ, 1), '占有 坪': round(occ / TSUBO, 1), '1台あたり 坪': round(occ / TSUBO / n, 2),
                'AGV 通路 m': round(c['agv_len'] / 1000, 1), 'うちシャッターまで m': round(c['route_len'] / 1000, 1),
                '通る防火シャッター': '・'.join('北' if i == 0 else '南' for i in c['doors']) or 'なし',
                '保管の台車 台': c['carts'], 'うちシャッターから15m以内 台': c['near'],
                '保管場所 坪': round(sa / TSUBO, 1),
                '敷地の残り 坪': round((SITE_AREA - c['used']) / 1e6 / TSUBO, 1),
                '人とAGVの交差': c['meta']['crossings'],
                '気になる点': ' / '.join(concerns(c)),
            })
    # 参考: 11 台は今の間隔では入らない。反操作側の人の通路を 0.5 m に詰めたときだけ 7＋4 で入る
    if 11 in counts and 11 in nores:
        old = gen.W_MACHINE
        gen.W_MACHINE = 500
        ref = [c for e in room_cands(7, '工場1') for w in room_cands(4, '工場2') for c in [combine(11, e, w)] if c]
        gen.W_MACHINE = old
        if ref:
            c = min(ref, key=lambda c: (round(c['occ'] / 1e6), c['agv_len']))
            c['split'] = (7, 4)
            add_storage(c)
            c['title'] = ('11 台 参考: 反操作側の人の通路を 1.0 → 0.5 m に詰めた場合（太い灰: 防火壁）\n' +
                          '\n'.join(describe(p) for p in c['parts']))
            draw(c, os.path.join(HERE, '11台_参考_反操作側0.5m.png'))
            if bg_env:
                draw(c, os.path.join(bg_env[1], '11台_参考_反操作側0.5m.png'), (bg_env[0], -609.35, -609.35, 34.82))
            occ = c['occ'] / 1e6
            rows.append({
                '台数': 11, '案': '参考（反操作側 0.5 m）', '工場1 台': 7, '工場2 台': 4,
                '並べ方': '＋'.join(describe(p) for p in c['parts']), '型の並び': ''.join(u.t for u in c['meta']['units']),
                '占有 m2': round(occ, 1), '占有 坪': round(occ / TSUBO, 1), '1台あたり 坪': round(occ / TSUBO / 11, 2),
                'AGV 通路 m': round(c['agv_len'] / 1000, 1), 'うちシャッターまで m': round(c['route_len'] / 1000, 1),
                '通る防火シャッター': '・'.join('北' if i == 0 else '南' for i in c['doors']) or 'なし',
                '保管の台車 台': c['carts'], 'うちシャッターから15m以内 台': c['near'],
                '保管場所 坪': round(c['store_area'] / 1e6 / TSUBO, 1),
                '敷地の残り 坪': round((SITE_AREA - c['used']) / 1e6 / TSUBO, 1),
                '人とAGVの交差': c['meta']['crossings'],
                '気になる点': ' / '.join(['反操作側の人の通路が 0.5 m（点検・扉の開閉に足りないおそれ）'] + concerns(c)),
            })
            print('ref11', round(occ / TSUBO, 1), c['carts'], flush=True)
    name = '一覧.csv' if os.environ.get('ONLY') is None else f"一覧-{os.environ['ONLY'].replace(',', '-')}.csv"
    with open(os.path.join(HERE, name), 'w', newline='', encoding='utf-8-sig') as f:
        wr = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        wr.writeheader()
        wr.writerows(rows)
    print('cap', cap, 'none', nores)


if __name__ == '__main__':
    main()
