"""Bakes the Draw globe's three images into public/images/lucky-draw/globe:
earth.webp (colour), relief.webp (R = land height, G = roughness), clouds.webp
(cloud cover). Run: python scripts/draw-globe/bake.py   (needs numpy + Pillow)

The coastlines are the hand-drawn rings in continents.py; swap that file for
real map data and re-run to sharpen them."""
import os
import numpy as np
from PIL import Image, ImageFilter
from continents import POLYS

OUT = os.path.join(os.path.dirname(__file__), '..', '..', 'public', 'images', 'lucky-draw', 'globe')
W, H = 2048, 1024


def hexc(h):
    h = h.lstrip('#')
    return np.array([int(h[i:i + 2], 16) for i in (0, 2, 4)], np.float32)


def ss(x, a, b):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def mix(a, b, t):
    return a + (b - a) * t[..., None]


def vnoise(p, seed):
    i = np.floor(p).astype(np.int64)
    f = (p - i).astype(np.float32)
    u = f * f * (3 - 2 * f)

    def h(dx, dy, dz):
        n = ((i[..., 0] + dx) * 374761393 + (i[..., 1] + dy) * 668265263 + (i[..., 2] + dz) * 2147483647
             + seed * 1442695041) & 0xFFFFFFFF
        n = ((n ^ (n >> 13)) * 1274126177) & 0xFFFFFFFF
        return ((n ^ (n >> 16)) & 0xFFFF).astype(np.float32) / 65535.0

    def lerp(a, b, t):
        return a + (b - a) * t

    x0 = lerp(lerp(h(0, 0, 0), h(1, 0, 0), u[..., 0]), lerp(h(0, 1, 0), h(1, 1, 0), u[..., 0]), u[..., 1])
    x1 = lerp(lerp(h(0, 0, 1), h(1, 0, 1), u[..., 0]), lerp(h(0, 1, 1), h(1, 1, 1), u[..., 0]), u[..., 1])
    return lerp(x0, x1, u[..., 2])


def fbm(p, scale, octaves, seed, gain=0.55):
    total, amp, norm = 0.0, 1.0, 0.0
    for o in range(octaves):
        total = total + amp * vnoise(p * scale * 2 ** o + 31.7 * o, seed + o)
        norm += amp
        amp *= gain
    return total / norm


def sphere(w, h):
    lon = np.radians((np.arange(w) + 0.5) * 360 / w - 180)
    lat = np.radians(90 - (np.arange(h) + 0.5) * 180 / h)
    lo, la = np.meshgrid(lon, lat)
    return np.stack([np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)], -1)


def land_mask(w, h):
    lon = (np.arange(w) + 0.5) * 360 / w - 180
    lat = 90 - (np.arange(h) + 0.5) * 180 / h
    X, Y = np.meshgrid(lon, lat)
    m = np.zeros((h, w), bool)
    for poly in POLYS:
        inside = np.zeros((h, w), bool)
        for k in range(len(poly)):
            x1, y1 = poly[k]
            x2, y2 = poly[(k + 1) % len(poly)]
            if y1 == y2:
                continue
            inside ^= ((y1 > Y) != (y2 > Y)) & (X < (x2 - x1) * (Y - y1) / (y2 - y1) + x1)
        m |= inside
    pad = 48
    img = Image.fromarray((np.concatenate([m[:, -pad:], m, m[:, :pad]], 1) * 255).astype(np.uint8))
    return np.asarray(img.filter(ImageFilter.GaussianBlur(4.5)), np.float32)[:, pad:-pad] / 255


def save(name, arr, quality):
    Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8)).save(os.path.join(OUT, name), quality=quality, method=6)
    print(name, os.path.getsize(os.path.join(OUT, name)) // 1024, 'KB')


P = sphere(W, H)
land = ss(land_mask(W, H), 0.35, 0.65)
n1 = fbm(P, 2.6, 4, 1)
n2 = fbm(P, 7.0, 4, 9)

# land colour by latitude, broken up by noise: tropics, desert belt, forest, snow
lat = np.abs(P[..., 2]) + (ss(n2, 0.25, 0.75) - 0.5) * 0.26
stops = [(0.0, '#2f9d48'), (0.2, '#57b24a'), (0.33, '#dcc56a'), (0.44, '#cdb65c'), (0.55, '#62a84d'),
         (0.8, '#3d8a50'), (0.9, '#eef3f6'), (1.0, '#ffffff')]
ground = np.zeros((H, W, 3), np.float32)
for (p0, c0), (p1, c1) in zip(stops, stops[1:]):
    t = np.clip((lat - p0) / (p1 - p0), 0, 1)
    sel = (lat >= p0) if p0 > 0 else np.ones_like(lat, bool)
    ground[sel] = mix(hexc(c0), hexc(c1), t)[sel]
ground *= (0.9 + 0.2 * n1)[..., None]
ground = mix(np.broadcast_to(hexc('#ecdca6'), ground.shape), ground, ss(land, 0.5, 0.68))

sea = mix(hexc('#0c3a8a'), hexc('#1f72d4'), ss(n1, 0.35, 0.65))
sea = mix(sea, np.broadcast_to(hexc('#3dbbe8'), sea.shape), ss(land, 0.04, 0.34))
shore = ss(land, 0.36, 0.5)
save('earth.webp', mix(sea, ground, shore), 86)

relief = np.zeros((H, W, 3), np.float32)
relief[..., 0] = land * 255
relief[..., 1] = (0.3 + 0.55 * shore) * 255
save('relief.webp', relief[::2, ::2], 80)

C = sphere(1024, 512)
cover = ss(fbm(C, 2.2, 3, 21, 0.5), 0.47, 0.62) * ss(fbm(C, 6.0, 5, 33, 0.6), 0.46, 0.6)
save('clouds.webp', np.repeat((cover * 255)[..., None], 3, 2), 78)
