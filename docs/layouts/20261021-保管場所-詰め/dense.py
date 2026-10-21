"""台車を「列」にまとめて詰めて並べる保管場所の取り方（3 つの資料で共通に使う）。

列の中では台車を隙間だけ空けて縦に並べ、列どうしも隙間だけ空けて横に並べる。
AGV の通路（幅 2,000）は列の両端にだけ通す（両端: 入口の端から入れて出口の端から出す、片端: 同じ端から出し入れ）。
台車の外形は 1,200 × 1,100 で、AGV は 1,200 の向きに潜り込む。列の向きも 1,200 の向き。

区画の取り方（空いた床のいちばん大きな長方形から順に、最大 6 区画）と、シャッターまで幅 2 m の道が
つながるかの確かめ方は、元の資料（../20261021-保管場所/gen_storage.py）と同じ。違うのは区画の中の並べ方だけ。
"""
from __future__ import annotations

import math
import os
import sys
from collections import deque

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
LAYOUTS = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(LAYOUTS, '20261021'))
sys.path.insert(0, os.path.join(LAYOUTS, '20261021-保管場所'))
import gen  # noqa: E402
import gen_site as gs  # noqa: E402
import gen_storage as gst  # noqa: E402
from gen_site import SITE_W, SITE_H, NOTCH_X, NOTCH_Y, SHUTTER, GRID  # noqa: E402

# ---- 詰めた並べ方の前提（どれも仮の値）----
CART_L = 1200        # 台車の外形の、列の向き（AGV が潜り込む向き）の長さ
CART_W = 1100        # 台車の外形の、列と直角の向きの幅
GAP = 100            # 台車どうしの隙間（列の中も、列どうしも）
S_AISLE = 2000       # 列の端の AGV の通路の幅
MIN_CARTS = gst.MIN_CARTS
MAX_ZONES = gst.MAX_ZONES
DAILY = 4            # 成形機 1 台で 1 日に満杯になる台車（1 台 1,200 枚、1 時間 200 枚、24 時間）

# 今の並べ方を数え直すときの台車（元の gen_storage の CART_D・CART_W を差し替える）
RECOUNT = dict(CART_D=1200, CART_W=1100)
ORIGINAL = dict(CART_D=gst.CART_D, CART_W=gst.CART_W)

H = S_AISLE / 2
X, Y = gst.X, gst.Y
NX, NY = gst.NX, gst.NY
EAST_GOAL = (X >= SITE_W - H - GRID) & (Y >= SHUTTER[0] + H) & (Y <= SHUTTER[1] - H)


class cart_size:
    """with cart_size(**RECOUNT): の中だけ、元の並べ方の台車の大きさを差し替える"""

    def __init__(self, **kw):
        self.kw = kw

    def __enter__(self):
        self.old = {k: getattr(gst, k) for k in self.kw}
        for k, v in self.kw.items():
            setattr(gst, k, v)

    def __exit__(self, *a):
        for k, v in self.old.items():
            setattr(gst, k, v)


# ---- 区画の中の並べ方 ----
def pack(r, ends=2):
    """四角 r（mm）に台車の列を詰めて並べる。
    ends=2: 列の両端に通路（入口と出口）。ends=1: 列の片端だけに通路。
    列の向き 2 通り × 片端の位置（ends=1 のとき 2 通り）× 横に通り抜けの通路を足すか（無し・左・右）を試す。
    返り値: 区画の dict のリスト（台数の多い順）"""
    x0, y0, x1, y1 = r
    pitch_l, pitch_w = CART_L + GAP, CART_W + GAP
    out = []
    for horiz in (True, False):          # True: 列が東西に延びる
        lng = (x1 - x0) if horiz else (y1 - y0)
        wid = (y1 - y0) if horiz else (x1 - x0)
        per = int((lng - ends * S_AISLE + GAP) // pitch_l)
        if per <= 0:
            continue
        run = per * pitch_l - GAP
        sides = ('both',) if ends == 2 else ('lo', 'hi')
        for side in sides:
            for lane in (None, 'lo', 'hi'):
                ncol = int((wid - (S_AISLE if lane else 0) + GAP) // pitch_w)
                if ncol <= 0:
                    continue
                cw = ncol * pitch_w - GAP
                used_w = cw + (S_AISLE if lane else 0)
                c0 = S_AISLE if lane == 'lo' else 0.0         # 列の幅の向きの始まり
                if side == 'both':
                    a0 = S_AISLE
                    end_rs = [(0.0, 0.0, S_AISLE, used_w), (a0 + run, 0.0, a0 + run + S_AISLE, used_w)]
                    used_l = run + 2 * S_AISLE
                elif side == 'lo':
                    a0 = S_AISLE
                    end_rs = [(0.0, 0.0, S_AISLE, used_w)]
                    used_l = run + S_AISLE
                else:
                    a0 = 0.0
                    end_rs = [(run, 0.0, run + S_AISLE, used_w)]
                    used_l = run + S_AISLE
                lanes = []
                if lane == 'lo':
                    lanes = [(0.0, 0.0, used_l, S_AISLE)]
                elif lane == 'hi':
                    lanes = [(0.0, cw, used_l, used_w)]
                carts, cidx = [], []
                for k in range(ncol):
                    w0 = c0 + k * pitch_w
                    for m in range(per):
                        l0 = a0 + m * pitch_l
                        carts.append((l0, w0, l0 + CART_L, w0 + CART_W))
                        cidx.append(k)

                def g(q):
                    if horiz:
                        return (x0 + q[0], y0 + q[1], x0 + q[2], y0 + q[3])
                    return (x0 + q[1], y0 + q[0], x0 + q[3], y0 + q[2])
                ends_g = [g(q) for q in end_rs]
                out.append(dict(rect=r, n=len(carts), carts=[g(c) for c in carts], cidx=cidx, ncol=ncol, per=per,
                                ends=ends_g, aisles=ends_g + [g(q) for q in lanes], spine=ends_g[0],
                                horiz=horiz, ne=ends, dir='東西' if horiz else '南北'))
    out.sort(key=lambda z: -z['n'])
    return out


def packer(ends):
    """区画を詰める候補。片端のときは、両端の並べ方も候補に入れる（片端の運用は両端の並べ方でもできる）"""
    if ends == 2:
        return lambda r: pack(r, 2)
    return lambda r: sorted(pack(r, 1) + pack(r, 2), key=lambda z: -z['n'])


def drop(z, boxes):
    """区画 z から、boxes（開口の前など）に掛かる台車を抜く"""
    keep = [(c, k) for c, k in zip(z['carts'], z['cidx']) if not any(gen.overlaps(c, b) for b in boxes)]
    z = dict(z)
    z['carts'] = [c for c, _ in keep]
    z['cidx'] = [k for _, k in keep]
    z['n'] = len(keep)
    return z


def cols(z):
    """列ごとの台数（多い順）"""
    cnt = {}
    for k in z['cidx']:
        cnt[k] = cnt.get(k, 0) + 1
    return sorted(cnt.values(), reverse=True)


def shrink(z):
    rs = z['carts'] + z['aisles']
    z['rect'] = (min(q[0] for q in rs), min(q[1] for q in rs), max(q[2] for q in rs), max(q[3] for q in rs))
    return z


# ---- 道の確かめ ----
def reach(agv_ok, el, zones, fixed_carts=(), extra=()):
    """台車をよけて、成形機の AGV の通路・各区画の端の通路・extra のすべてが東のシャッターとつながるか"""
    from scipy import ndimage
    ok = agv_ok(el, list(fixed_carts) + [c for z in zones for c in z['carts']])
    lab, _ = ndimage.label(ok)
    gl = set(np.unique(lab[EAST_GOAL & ok])) - {0}
    if not gl:
        return False
    rs = [r for k, r, _ in el if k == 'aisle'] + [a for z in zones for a in z['aisles']] + list(extra)
    return all(any(lab[c] in gl for c in gst.center_cells(r)) for r in rs)


def fill(free, packer, check, max_zones=MAX_ZONES):
    """空いた床（升の真偽表）のいちばん大きな長方形から順に区画を取る（元の資料と同じ手順）"""
    m = free.copy()
    zones = []
    for _ in range(max_zones):
        rr = gst.largest_rect(m)
        if rr is None:
            break
        j0, i0, j1, i1 = rr
        r = (i0 * GRID, j0 * GRID, i1 * GRID, j1 * GRID)
        m[j0:j1, i0:i1] = False
        placed = None
        for z in packer(r):
            if z['n'] < MIN_CARTS:
                continue
            if check(zones + [z]):
                placed = z
                break
        if placed is None:
            if (j1 - j0) * (i1 - i0) * GRID * GRID < 15e6:
                break
            continue
        zones.append(shrink(placed))
    return zones


def bfs(ok, goal=None):
    goal = (EAST_GOAL if goal is None else goal) & ok
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
    cand = [c for c in gst.center_cells(r) if dist[c] >= 0]
    return min(cand, key=lambda c: dist[c]) if cand else None


def path_cells(dist, par, start):
    j, i = start
    p = [(j, i)]
    while dist[j, i] > 0:
        j, i = par[j, i]
        p.append((int(j), int(i)))
    return p


def connect(agv_ok, el, zones, fixed_carts=()):
    """区画ごとに、出口（両端のときはシャッターに近い方の端）と入口を決め、端からシャッターまでの道を引く。
    区画の道が成形機の通路からの道と重なるかを z['cross'] に入れる。返り値: 描く道の四角（成形機の通路からの道も含む）"""
    ok = agv_ok(el, list(fixed_carts) + [c for z in zones for c in z['carts']])
    dist, par = bfs(ok)
    mcells, starts = set(), []
    for k, r, _ in el:
        if k == 'aisle':
            s = nearest(dist, r)
            if s is not None:
                starts.append(s)
                mcells |= set(path_cells(dist, par, s))
    for z in zones:
        ds = []
        for e in z['ends']:
            s = nearest(dist, e)
            ds.append((dist[s] if s is not None else 10 ** 9, s, e))
        ds.sort(key=lambda t: t[0])
        z['exit'] = ds[0][2]
        z['entry'] = ds[-1][2] if len(ds) > 1 else ds[0][2]
        z['dist'] = ds[0][0] * GRID + H if ds[0][1] is not None else float('nan')
        zc = set()
        for d, s, _ in ds:
            if s is not None:
                starts.append(s)
                zc |= set(path_cells(dist, par, s))
        z['cross'] = len(zc & mcells) > 0
    segs, _ = gst.trace(dist, par, starts) if starts else ([], 0)
    return segs


def near_count(zones):
    sx, sy = SITE_W, (SHUTTER[0] + SHUTTER[1]) / 2
    return sum(1 for z in zones for q in z['carts'] if math.hypot((q[0] + q[2]) / 2 - sx, (q[1] + q[3]) / 2 - sy) <= gst.NEAR)


def cols_text(zones, label=None):
    """区画ごとの列の台数を「保管 1 18 列 × 12 台」の形で"""
    out = []
    for zi, z in enumerate(zones, 1):
        cs = cols(z)
        if not cs:
            continue
        nm = label(zi) if label else f'保管 {zi}'
        if cs[0] == cs[-1]:
            out.append(f'{nm} {len(cs)} 列 × {cs[0]} 台')
        else:
            out.append(f'{nm} {len(cs)} 列（{cs[-1]}〜{cs[0]} 台）')
    return '、'.join(out)


def deepest(zones):
    return max((max(cols(z)) for z in zones if z['carts']), default=0)


def tsubo(a):
    return a / 1e6 / gen.TSUBO


# ---- 描画 ----
def draw(c, zones, route, path, title, background=None, extra=None, store_label=None):
    """c['el'] の成形機まわりと、詰めた保管の区画を描く。extra(ax, box) で壁などを足す"""
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

    def box(r, **kw):
        ax.add_patch(Rectangle((r[0] * s, r[1] * s), (r[2] - r[0]) * s, (r[3] - r[1]) * s, **kw))
    if extra:
        extra(ax, box)
    for kind in ['walk', 'aisle', 'route', 'store', 'machine', 'clamp', 'inj', 'opline', 'lane', 'part', 'beam']:
        if kind == 'route':
            for r in route:
                box(r, fc='#cfe9cf', ec='none', zorder=2)
            continue
        if kind == 'store':
            for zi, z in enumerate(zones, 1):
                box(z['rect'], fc='#fff3e0', ec='#d9822b', lw=1.2, ls='--', zorder=2)
                for r in z['aisles']:
                    box(r, fc='#cfe9cf', ec='none', zorder=2.1)
                for r in z['carts']:
                    box(r, fc='#f2b56b', ec='#a85c12', lw=0.3, zorder=2.2)
                # 入口と出口の端
                for e, t in ([(z.get('entry'), '入'), (z.get('exit'), '出')] if z['ne'] == 2 else [(z.get('exit'), '出入')]):
                    if e is None:
                        continue
                    ax.text((e[0] + e[2]) / 2 * s, (e[1] + e[3]) / 2 * s, t, ha='center', va='center', fontsize=7,
                            color='#1d5e1d', zorder=3.2, bbox=dict(fc='white', ec='#3a8a3a', lw=0.5, pad=0.8))
                zr = z['rect']
                nm = store_label(zi, z) if store_label else f"保管 {zi}\n{z['n']} 台"
                ax.text((zr[0] + zr[2]) / 2 * s, (zr[1] + zr[3]) / 2 * s, nm, ha='center', va='center',
                        fontsize=8.5, color='#7a3d00', zorder=3, bbox=dict(fc='white', ec='none', alpha=0.8, pad=1.5))
            continue
        for k, r, ex in c['el']:
            if k != kind:
                continue
            st = dict(fc=ex[0], ec='#555', lw=0.5) if k == 'part' else sty[k]
            box(r, zorder=2, **st)
    for k, r, ex in c['el']:
        if k == 'label':
            ax.text(r[0] * s, r[1] * s, ex, ha='center', va='center', fontsize=10, zorder=3)
        elif k == 'small':
            ax.text(r[0] * s, r[1] * s, ex, ha='center', va='center', fontsize=5.5, color='#555', zorder=3)
    box(gst.APRON_R, fc='none', ec='#2d7a2d', lw=0.6, ls=':', zorder=2)
    ax.plot([SITE_W * s, SITE_W * s], [SHUTTER[0] * s, SHUTTER[1] * s], color='#2d7a2d', lw=5, zorder=3)
    ax.add_patch(FancyArrow(SITE_W * s + 0.3, (SHUTTER[0] + SHUTTER[1]) / 2 * s, 2.0, 0, width=0.5, head_width=1.3, head_length=0.9, color='#2d7a2d', zorder=3))
    ax.text(SITE_W * s + 0.4, SHUTTER[0] * s - 0.6, 'シャッター\n（梱包へ）', fontsize=8, color='#2d7a2d', va='bottom')
    ax.text(NOTCH_X / 2 * s, NOTCH_Y / 2 * s, '（敷地の外）', ha='center', va='center', fontsize=8, color='#999')
    ax.set_xlim(-1.5, SITE_W * s + 6)
    ax.set_ylim(SITE_H * s + 1.5, -1.5)
    ax.set_xticks(range(0, 36, 5))
    ax.set_yticks(range(0, 46, 5))
    ax.tick_params(labelsize=7)
    ax.grid(color='#eee', lw=0.5, zorder=0)
    ax.set_title(title, fontsize=9, loc='left')
    fig.text(0.01, 0.005, f'橙の箱: 保管の台車（{CART_L:,} × {CART_W:,}、隙間 {GAP}。列は台車の {CART_L:,} の向き）　橙の破線: 保管の区画　'
             '緑: AGV の通路・道（区画の両端の「入」「出」）　点線: シャッター前の溜まり　灰: 成形機　色の箱: 帯の装置　薄い黄: 人の通路',
             fontsize=6.3, color='#444')
    fig.tight_layout(rect=(0, 0.015, 1, 1))
    fig.savefig(path, dpi=110)
    plt.close(fig)
    from PIL import Image
    Image.open(path).convert('RGB').quantize(colors=200 if background else 64, method=Image.Quantize.MEDIANCUT).save(path, optimize=True)
