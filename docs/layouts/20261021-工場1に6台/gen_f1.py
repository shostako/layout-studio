"""工場1 に成形機を 6 台置き、工場2 を製品の保管場所（台車ごと置く）にする案を作る。

使い方: python3 gen_f1.py [背景画像 出力フォルダ]
  引数なし: このフォルダに外形線だけの平面図 PNG と 一覧.csv を書く
  引数あり: 背景画像（室内の図面）を敷いた平面図を、出力フォルダにも書く（リポには入れない）

成形機 1 台分の帯（A〜D）と間隔は ../20261021/gen.py、並べ方の組み立ては ../20261021/gen_site.py、
台車の並べ方は ../20261021-保管場所/gen_storage.py をそのまま使う（それらの資料は変えない）。
ここでは工場1 と工場2 の間の仕切り X3（防火壁）を実在の壁として扱い、
AGV は壁の 2 か所の防火シャッターの開口だけを通って工場2 へ行き来する。
"""
from __future__ import annotations

import csv
import math
import os
import sys
from collections import deque

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), '20261021'))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), '20261021-保管場所'))
import gen  # noqa: E402
import gen_site as gs  # noqa: E402
import gen_storage as st  # noqa: E402
from gen import AISLE, TSUBO, PATTERNS, TYPESET_JA  # noqa: E402
from gen_site import SITE_W, SITE_H, NOTCH_X, NOTCH_Y, SHUTTER, GRID, AGV_CLEAR, ROT_JA  # noqa: E402
from gen_storage import X, Y, NX, NY, rect_mask, site_mask, pack, largest_rect, WALL_MARGIN, APRON_R  # noqa: E402

# ---- 仕切り（防火壁）と開口 ----
WALL = (15300, 16200)                  # X3。壁の厚みと東側に約 0.7 m 出る柱をまとめた置けない帯（../20261021-防火壁/ と同じ）
F1 = (WALL[1], 0, SITE_W, SITE_H)      # 工場1 の床 19.3 × 45.7 m
F2 = (0, NOTCH_Y, WALL[0], SITE_H)     # 工場2 の床 15.3 × 39.3 m
OPENINGS = [('北', (7400, 10600)), ('南', (38900, 42200))]   # 防火シャッターの開口（工場1 の北壁からの y）
OPEN_CLEAR = 2500                      # 開口の両側に物を置かない奥行（シャッターの降下と AGV の出入り。../20261021-防火壁/ と同じ）
OPEN_SIDE = 500                        # 同じく、開口の幅の上下に足す分
N = 6
H = AISLE / 2


def open_apron(y0, y1):
    return (WALL[0] - OPEN_CLEAR, y0 - OPEN_SIDE, WALL[1] + OPEN_CLEAR, y1 + OPEN_SIDE)


APRONS = [open_apron(*o) for _, o in OPENINGS]


def in_rect(r, box, eps=1e-6):
    return r[0] >= box[0] - eps and r[1] >= box[1] - eps and r[2] <= box[2] + eps and r[3] <= box[3] + eps


# ---- AGV の通れる升（台車を載せて幅 2 m の中心）----
def wall_block():
    m = (X > WALL[0] - H) & (X < WALL[1] + H)
    for _, (y0, y1) in OPENINGS:
        m &= ~((Y >= y0 + H) & (Y <= y1 - H))
    return m


WALL_BLOCK = wall_block()
OPEN_CELLS = [(X > WALL[0] - H) & (X < WALL[1] + H) & (Y >= y0 + H) & (Y <= y1 - H) for _, (y0, y1) in OPENINGS]
EAST_GOAL = (X >= SITE_W - H - GRID) & (Y >= SHUTTER[0] + H) & (Y <= SHUTTER[1] - H)


def agv_ok(el, carts=()):
    ok = site_mask(H) & ~WALL_BLOCK
    for k, r, _ in el:
        if k in ('machine', 'part'):
            ok &= ~rect_mask(r, H + AGV_CLEAR)
    for r in carts:
        ok &= ~rect_mask(r, H - GRID * 0.75)
    return ok


def bfs(ok, goal):
    goal = goal & ok
    dist = np.full(ok.shape, -1, dtype=np.int32)
    par = np.full(ok.shape + (2,), -1, dtype=np.int32)
    q = deque()
    for j, i in zip(*np.nonzero(goal)):
        dist[j, i] = 0
        q.append((j, i))
    while q:
        j, i = q.popleft()
        for dj, di in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            a, b = j + dj, i + di
            if 0 <= a < NY and 0 <= b < NX and ok[a, b] and dist[a, b] < 0:
                dist[a, b] = dist[j, i] + 1
                par[a, b] = (j, i)
                q.append((a, b))
    return dist, par


def nearest(dist, r):
    cand = [c for c in st.center_cells(r) if dist[c] >= 0]
    return min(cand, key=lambda c: dist[c]) if cand else None


def trace(dist, par, start, to_east=False):
    """升の道を直線ごとの四角（幅 2 m）にまとめる。返り値: (四角, 升の集合, 長さ mm)"""
    j, i = start
    path = [(j, i)]
    while dist[j, i] > 0:
        j, i = par[j, i]
        path.append((int(j), int(i)))
    pts = [((i + 0.5) * GRID, (j + 0.5) * GRID) for j, i in path]
    if to_east:
        pts.append((SITE_W, pts[-1][1]))
    segs, s = [], 0
    for t in range(1, len(pts)):
        if t == len(pts) - 1 or (pts[t + 1][0] != pts[s][0] and pts[t + 1][1] != pts[s][1]):
            (xa, ya), (xb, yb) = pts[s], pts[t]
            if (xa, ya) != (xb, yb):
                segs.append((min(xa, xb) - H, min(ya, yb) - H, min(SITE_W, max(xa, xb) + H), max(ya, yb) + H))
            s = t
    if len(pts) == 1:
        x, y = pts[0]
        segs.append((x - H, y - H, x + H, y + H))
    return segs, set(path), dist[start] * GRID + (H if to_east else 0)


# ---- 成形機の並べ方（工場1 の中だけ）----
def candidates():
    res = []
    fw, fh = F1[2] - F1[0], F1[3] - F1[1]
    for sname, spec in gs.specs(N):
        for p in PATTERNS:
            for ts in gen.TYPESETS:
                el0, meta = gs.assemble(N, spec, p, ts, [0] * len(spec))
                if gs.gen_warn(el0):
                    continue
                for rot in range(4):
                    b = gs.bbox(gs.transform(el0, rot))
                    w, hh = b[2] - b[0], b[3] - b[1]
                    if w > fw or hh > fh:
                        continue
                    tys = sorted(set(list(range(0, int(fh - hh) + 1, 1000)) + [fh - hh]))
                    for tx in sorted(set(range(int(F1[0]), int(F1[2] - w), 500)) | {F1[2] - w}):
                        for ty in tys:
                            el = gs.transform(el0, rot, tx, ty)
                            if all(in_rect(e[1], F1) for e in el if e[0] in gs.FIT_KINDS) and not any(
                                    gen.overlaps(e[1], a) for e in el if e[0] in ('machine', 'part', 'lane') for a in APRONS):
                                res.append(dict(structure=sname, spec=spec, pattern=p, typeset=ts, rot=rot, tx=tx, ty=ty,
                                                el=el, meta=meta, w=w, h=hh))
    return res


# ---- 工場2 の保管場所 ----
F2_IN = (F2[0] + WALL_MARGIN, F2[1] + WALL_MARGIN, F2[2] - WALL_MARGIN, F2[3] - WALL_MARGIN)


def f2_options():
    """工場2 の床を 1 つの区画として台車を並べる 4 通り（通路の向き × 幹の端）。開口の前の台車は抜く"""
    out = []
    for n, carts, aisles, spine, name in pack(F2_IN):
        carts = [c for c in carts if not any(gen.overlaps(c, a) for a in APRONS)]
        out.append(dict(rect=F2_IN, carts=carts, n=len(carts), aisles=aisles, spine=spine, dir=name))
    return out


def zone_reach(ok_lab, gl, z):
    return any(ok_lab[c] in gl for c in st.center_cells(z['spine'])) or any(
        ok_lab[c] in gl for a in z['aisles'] for c in st.center_cells(a))


def evaluate(c, f2opts):
    from scipy import ndimage
    el = c['el']
    base = agv_ok(el)
    aisles = [r for k, r, _ in el if k == 'aisle']
    # 成形機の通路 → 東のシャッター
    dE, pE = bfs(base, EAST_GOAL)
    starts = [nearest(dE, r) for r in aisles]
    if any(s is None for s in starts):
        return None
    # 成形機の通路 → 開口（どちらか近い方）
    dO = [bfs(base, oc) for oc in OPEN_CELLS]
    open_ok = [all(nearest(d, r) is not None for r in aisles) for d, _ in dO]
    if not any(open_ok):
        return None
    best = None
    for z in f2opts:
        ok = agv_ok(el, z['carts'])
        lab, _ = ndimage.label(ok)
        gl = set(np.unique(lab[EAST_GOAL & ok])) - {0}
        if not gl or not zone_reach(lab, gl, z):
            continue
        if not all(any(lab[q] in gl for q in st.center_cells(r)) for r in aisles):
            continue
        if best is None or z['n'] > best['n']:
            best = z
    if best is None:
        return None
    z2 = best
    ok2 = agv_ok(el, z2['carts'])
    dE2, pE2 = bfs(ok2, EAST_GOAL)
    dO2 = [bfs(ok2, oc) for oc in OPEN_CELLS]
    segs, cells = [], set()
    # 成形機 → シャッター（直接の出荷・空台車の戻り）
    m_e = 0.0
    for s in [nearest(dE2, r) for r in aisles]:
        sg, cl, ln = trace(dE2, pE2, s, True)
        segs += sg; cells |= cl; m_e = max(m_e, ln)
    # 成形機 → 開口（工場2 へ）。各通路から近い方の開口
    m_o, used = 0.0, set()
    for r in aisles:
        opts = [(dO2[k][0][nearest(dO2[k][0], r)] if nearest(dO2[k][0], r) is not None else 10 ** 9, k) for k in range(2)]
        dmin, k = min(opts)
        if dmin >= 10 ** 9:
            return None
        sg, cl, ln = trace(dO2[k][0], dO2[k][1], nearest(dO2[k][0], r))
        segs += sg; cells |= cl; m_o = max(m_o, ln); used.add(k)
        # 通路のすぐ脇（2 m 以内）にあるもう一方の開口も使える
        for dd, kk in opts:
            if dd * GRID <= 2000:
                used.add(kk)
    # 工場2 の保管 → 東のシャッター（出荷）。保管の幹から
    sz = nearest(dE2, z2['spine'])
    if sz is None:
        sz = min((q for a in z2['aisles'] for q in st.center_cells(a) if dE2[q] >= 0), key=lambda q: dE2[q], default=None)
    if sz is None:
        return None
    zsegs, zcells, s_e = trace(dE2, pE2, sz, True)
    # 工場2 側の道（区画の中）は区画の通路で足りるので、描く道は工場1 側だけ
    zsegs = [r for r in zsegs if r[2] > WALL[0]]
    via = [k for k in range(2) if any(OPEN_CELLS[k][q] for q in zcells)]
    # 工場1 の残りに置ける台車（参考）: 道・開口の前・シャッターの前を空けて詰める
    m = site_mask(WALL_MARGIN + GRID / 2) & (X > WALL[1] + WALL_MARGIN + GRID / 2)
    for k, r, _ in el:
        if k in ('col', 'walk', 'aisle', 'machine', 'part', 'lane'):
            m &= ~rect_mask(r, GRID / 2)
    for r in segs + zsegs + APRONS + [APRON_R]:
        m &= ~rect_mask(r, GRID / 2)
    zones1 = []
    for _ in range(st.MAX_ZONES):
        rr = largest_rect(m)
        if rr is None:
            break
        j0, i0, j1, i1 = rr
        r = (i0 * GRID, j0 * GRID, i1 * GRID, j1 * GRID)
        m[j0:j1, i0:i1] = False
        placed = None
        for o in pack(r):
            if o[0] < st.MIN_CARTS:
                continue
            z = dict(rect=r, n=o[0], carts=o[1], aisles=o[2], spine=o[3], dir=o[4])
            ok = agv_ok(el, z2['carts'] + [q for zz in zones1 + [z] for q in zz['carts']])
            lab, _ = ndimage.label(ok)
            gl = set(np.unique(lab[EAST_GOAL & ok])) - {0}
            rs = aisles + [zz['spine'] for zz in zones1 + [z]]
            if gl and zone_reach(lab, gl, z2) and all(any(lab[q] in gl for q in st.center_cells(x)) for x in rs):
                placed = z
                break
        if placed is None:
            if (j1 - j0) * (i1 - i0) * GRID * GRID < 15e6:
                break
            continue
        rs = placed['carts'] + placed['aisles'] + [placed['spine']]
        placed['rect'] = (min(q[0] for q in rs), min(q[1] for q in rs), max(q[2] for q in rs), max(q[3] for q in rs))
        zones1.append(placed)
    c.update(z2=z2, zones1=zones1, route=segs + zsegs, m_e=m_e, m_o=m_o, s_e=s_e, via=via, used_open=sorted(used),
             open_ok=open_ok)
    c['carts2'] = z2['n']
    c['carts1'] = sum(z['n'] for z in zones1)
    c['area2'] = gen.union_area([z2['rect']])
    c['area1'] = gen.union_area([z['rect'] for z in zones1]) if zones1 else 0.0
    c['occ'] = gs.occupied(el, segs)
    c['agv_len'] = gs.aisle_len(el) + m_e + m_o
    return c


DETOUR = 35000   # 成形機→開口と工場2→シャッターの合計がこれを超える置き方は、台車が多くても後ろに回す


def key(c):
    return (-c['carts2'], c['m_o'] + c['s_e'] > DETOUR, -c['carts1'], c['m_o'] + c['s_e'])


def pick(cs):
    best = {}
    for c in cs:
        k = (c['structure'], c['pattern'], c['typeset'], c['rot'])
        if k not in best or key(c) < key(best[k]):
            best[k] = c
    cs = sorted(best.values(), key=key)
    out, seen = [], set()
    for c in cs:
        k = (c['structure'], c['pattern'], c['rot'])
        if k not in seen:
            seen.add(k)
            out.append(c)
    # 操作側が空く型（C と D）の最良も入れる
    b = next((c for c in cs if c['typeset'] == 'nonop'), None)
    if b is not None and b not in out:
        out.append(b)
    out.sort(key=key)
    return out[:10]


# ---- 描画 ----
def draw(c, path, background=None):
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    from matplotlib import font_manager
    from matplotlib.patches import Rectangle, Polygon, FancyArrow
    fp = '/usr/share/fonts/opentype/ipafont-gothic/ipagp.ttf'
    if os.path.exists(fp):
        font_manager.fontManager.addfont(fp)
        plt.rcParams['font.family'] = font_manager.FontProperties(fname=fp).get_name()
    s = 1 / 1000
    fig, ax = plt.subplots(figsize=(11, 13.2), dpi=110)
    ax.set_aspect('equal')
    if background:
        from PIL import Image
        img, x0, y0, mpp = background
        im = Image.open(img)
        ax.imshow(im, extent=(x0 * s, (x0 + im.size[0] * mpp) * s, (y0 + im.size[1] * mpp) * s, y0 * s), alpha=0.45, zorder=0)
    ax.add_patch(Polygon([(x * s, y * s) for x, y in gs.SITE_POLY], closed=True, fill=not background, fc='#fafafa', ec='#222', lw=1.6, zorder=1))

    def box(r, **kw):
        ax.add_patch(Rectangle((r[0] * s, r[1] * s), (r[2] - r[0]) * s, (r[3] - r[1]) * s, **kw))
    # 防火壁と開口
    y = NOTCH_Y
    for _, (o0, o1) in OPENINGS:
        box((WALL[0], y, WALL[1], o0), fc='#555', ec='none', zorder=3)
        box((WALL[0], o0, WALL[1], o1), fc='#e04040', ec='none', zorder=3)
        y = o1
    box((WALL[0], y, WALL[1], SITE_H), fc='#555', ec='none', zorder=3)
    for (nm, (o0, o1)), ar in zip(OPENINGS, APRONS):
        box(ar, fc='none', ec='#e04040', lw=0.6, ls=':', zorder=2.5)
        ax.text(WALL[1] * s + 0.2, o0 * s - 0.25, f'防火シャッター（{nm}）', fontsize=6.5, color='#c03030', va='bottom', zorder=4)
    sty = {
        'walk': dict(fc='#fbf1d6', ec='none', alpha=0.9),
        'aisle': dict(fc='#cfe9cf', ec='#3a8a3a', lw=0.8),
        'machine': dict(fc='#dfe2e6', ec='#666', lw=0.8),
        'clamp': dict(fc='#cfd3d9', ec='none'),
        'inj': dict(fc='#c3c8cf', ec='#999', lw=0.4),
        'opline': dict(fc='#d33', ec='none'),
        'lane': dict(fc='none', ec='#3a8a3a', lw=0.6, ls='--'),
        'beam': dict(fc='none', ec='#2a5fc4', lw=0.8, ls='-.'),
    }
    for kind in ['walk', 'aisle', 'route', 'store', 'machine', 'clamp', 'inj', 'opline', 'lane', 'part', 'beam']:
        if kind == 'route':
            for r in c['route']:
                box(r, fc='#cfe9cf', ec='none', zorder=2)
            continue
        if kind == 'store':
            for zi, z in enumerate([c['z2']] + c['zones1']):
                box(z['rect'], fc='#fff3e0', ec='#d9822b', lw=1.2, ls='--', zorder=2)
                for r in z['aisles'] + [z['spine']]:
                    box(r, fc='#cfe9cf', ec='none', zorder=2.1)
                for r in z['carts']:
                    box(r, fc='#f2b56b', ec='#a85c12', lw=0.4, zorder=2.2)
                zr = z['rect']
                lab = f"工場2 の保管\n{z['n']} 台" if zi == 0 else f"工場1 の残り\n{z['n']} 台"
                ax.text((zr[0] + zr[2]) / 2 * s, (zr[1] + zr[3]) / 2 * s, lab, ha='center', va='center',
                        fontsize=10 if zi == 0 else 8, color='#7a3d00', zorder=3, bbox=dict(fc='white', ec='none', alpha=0.8, pad=1.5))
            continue
        for k, r, extra in c['el']:
            if k != kind:
                continue
            stl = dict(fc=extra[0], ec='#555', lw=0.5) if k == 'part' else sty[k]
            box(r, zorder=2, **stl)
    for k, r, extra in c['el']:
        if k == 'label':
            ax.text(r[0] * s, r[1] * s, extra, ha='center', va='center', fontsize=10, zorder=3)
        elif k == 'small':
            ax.text(r[0] * s, r[1] * s, extra, ha='center', va='center', fontsize=5.5, color='#555', zorder=3)
    box(APRON_R, fc='none', ec='#2d7a2d', lw=0.6, ls=':', zorder=2)
    ax.plot([SITE_W * s, SITE_W * s], [SHUTTER[0] * s, SHUTTER[1] * s], color='#2d7a2d', lw=5, zorder=3)
    ax.add_patch(FancyArrow(SITE_W * s + 0.3, (SHUTTER[0] + SHUTTER[1]) / 2 * s, 2.0, 0, width=0.5, head_width=1.3, head_length=0.9, color='#2d7a2d', zorder=3))
    ax.text(SITE_W * s + 0.4, SHUTTER[0] * s - 0.6, 'シャッター\n（梱包へ）', fontsize=8, color='#2d7a2d', va='bottom')
    ax.text(NOTCH_X / 2 * s, NOTCH_Y / 2 * s, '（敷地の外）', ha='center', va='center', fontsize=8, color='#999')
    ax.text(1.0, NOTCH_Y * s + 0.3, '工場2', fontsize=9, color='#444', va='top', zorder=4)
    ax.text(WALL[1] * s + 0.3, 0.3, '工場1', fontsize=9, color='#444', va='top', zorder=4)
    ax.set_xlim(-1.5, SITE_W * s + 6)
    ax.set_ylim(SITE_H * s + 1.5, -1.5)
    ax.set_xticks(range(0, 36, 5))
    ax.set_yticks(range(0, 46, 5))
    ax.tick_params(labelsize=7)
    ax.grid(color='#eee', lw=0.5, zorder=0)
    a2 = c['area2'] / 1e6
    ax.set_title(f"{c['title']}\n工場2 の保管 台車 {c['carts2']} 台・{a2:,.0f} m²（{a2 / TSUBO:,.0f} 坪）　工場1 の残りに {c['carts1']} 台（参考）\n"
                 f"成形機まわりの占有 {c['occ'] / 1e6:,.0f} m²（{c['occ'] / 1e6 / TSUBO:,.0f} 坪）　AGV の道: 成形機→開口 {c['m_o'] / 1000:.0f} m、"
                 f"成形機→シャッター {c['m_e'] / 1000:.0f} m、工場2→シャッター {c['s_e'] / 1000:.0f} m", fontsize=9, loc='left')
    fig.text(0.01, 0.005, '橙の箱: 保管の台車（1 台 1,100 × 900 の枠）　橙の破線: 保管の区画　緑: AGV の通路・道　黒: 防火壁 X3　赤: 防火シャッターの開口'
             '（点線は物を置かない範囲）　灰: 成形機　色の箱: 帯の装置　薄い黄: 人の通路', fontsize=6.5, color='#444')
    fig.tight_layout(rect=(0, 0.015, 1, 1))
    fig.savefig(path, dpi=110)
    plt.close(fig)
    from PIL import Image
    Image.open(path).convert('RGB').quantize(colors=200 if background else 64, method=Image.Quantize.MEDIANCUT).save(path, optimize=True)


def concerns(c):
    lines = []
    names = [OPENINGS[k][0] for k in c['used_open']]
    lines.append('成形機から工場2 へは' + '・'.join(names) + 'の開口を通る' + ('（AGV の通路が両方の開口の前を通る）' if len(names) == 2 else ''))
    lines.append('工場2 の保管から出荷は' + ('・'.join(OPENINGS[k][0] for k in c['via']) or '―') + 'の開口を通ってシャッターへ')
    us = c['meta']['units']
    nop = sum(1 for u in us if u.op_band())
    lines.append('全台、操作側に帯' if nop == len(us) else ('全台、操作側が空く' if nop == 0 else f'{nop} 台は操作側に帯'))
    lines.append(f"人の横の通路が AGV の通路を {c['meta']['crossings']} か所で横切る")
    return lines


def main():
    bg_env = None
    if len(sys.argv) >= 3:
        bg_env = (sys.argv[1], sys.argv[2])
        os.makedirs(bg_env[1], exist_ok=True)
    cs = candidates()
    f2opts = f2_options()
    print('候補', len(cs), '工場2 の並べ方', [(z['dir'], z['n']) for z in f2opts], flush=True)
    groups = {}
    for c in cs:
        groups.setdefault((c['structure'], c['pattern'], c['typeset'], c['rot'] % 2), []).append(c)
    ev = []
    for k, v in groups.items():
        for c in v:
            e = evaluate(c, f2opts)
            if e:
                ev.append(e)
    print('つながる案', len(ev), flush=True)
    out = pick(ev)
    rows = []
    for no, c in enumerate(out, 1):
        c['no'] = no
        c['title'] = f"6 台 案 {no}: {c['structure']}、{PATTERNS[c['pattern']]}、{TYPESET_JA[c['typeset']]}、{ROT_JA[c['rot']]}"
        draw(c, os.path.join(HERE, f'6台_案{no}.png'))
        if bg_env:
            draw(c, os.path.join(bg_env[1], f'6台_案{no}.png'), (bg_env[0], -609.35, -609.35, 34.82))
        occ = c['occ'] / 1e6
        rows.append({
            '案': no, '列の組み方': c['structure'], '積み方': PATTERNS[c['pattern']], '型': TYPESET_JA[c['typeset']],
            '成形機の向き': ROT_JA[c['rot']], '型の並び': ''.join(u.t for u in c['meta']['units']),
            '工場2 保管の台車 台': c['carts2'], '工場2 保管場所 m2': round(c['area2'] / 1e6, 1), '工場2 保管場所 坪': round(c['area2'] / 1e6 / TSUBO, 1),
            '工場2 の通路の向き': c['z2']['dir'],
            '工場1 の残りの台車 台': c['carts1'], '工場1 の残りの保管 坪': round(c['area1'] / 1e6 / TSUBO, 1),
            '成形機まわりの占有 坪': round(occ / TSUBO, 1), '1台あたり 坪': round(occ / TSUBO / N, 1),
            '成形機→開口 m': round(c['m_o'] / 1000, 1), '成形機→シャッター m': round(c['m_e'] / 1000, 1),
            '工場2→シャッター m': round(c['s_e'] / 1000, 1),
            '使う開口': '・'.join(OPENINGS[k][0] for k in c['used_open']),
            '気になる点': ' / '.join(concerns(c)),
        })
        print(no, c['structure'], c['pattern'], c['typeset'], c['rot'], c['carts2'], c['carts1'], round(c['m_o']), round(c['s_e']), flush=True)
    with open(os.path.join(HERE, '一覧.csv'), 'w', newline='', encoding='utf-8-sig') as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    return rows


if __name__ == '__main__':
    main()
