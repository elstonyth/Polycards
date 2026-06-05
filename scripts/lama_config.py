# Shared config for the LaMa re-brand pipeline. Only the 11 machines whose banner
# actually says "phygitals". The 5 one-piece machines are tier-branded (restored, not
# rebranded). kind: "dark" = dark wordmark on light banner (BLACK-HAT); "white" =
# light wordmark on dark/glowing banner (TOP-HAT).
PURPLE = (104, 108, 190)
WHITE = (245, 247, 252)

# White/gold banner + DARK wordmark → black-hat + purple text
POKEMON_DARKTEXT = ["mythic-pack", "legend-pack", "rookie-pack", "trainer-pack"]
# Same machine model but DARK/GREY banner + bright wordmark (elite=red, platinum=white)
# → top-hat + white text
POKEMON_LIGHTTEXT = ["elite-pack", "platinum-pack"]
RESTORE = ["elite-one-piece-pack", "legend-one-piece-pack", "one-piece-platinum-pack",
           "one-piece-sealed-claw-mcmnf5", "starter-one-piece-pack"]

# base -> dict(src, kind, band(x0,x1,y0,y1), color, centre(cx,cy), twf)
JOBS = {}
for b in POKEMON_DARKTEXT:
    JOBS[b] = dict(src=f"{b}-machine.avif", kind="dark", band=(0.37, 0.61, 0.153, 0.223),
                   color=PURPLE, centre=(0.488, 0.185), twf=0.165)
for b in POKEMON_LIGHTTEXT:
    JOBS[b] = dict(src=f"{b}-machine.avif", kind="white", band=(0.37, 0.61, 0.153, 0.223),
                   color=WHITE, centre=(0.5, 0.185), twf=0.165)
# Riftbound: ornate GOLD glowing wordmark on a dark-blue plate. Band confined to the PLATE
# (not the grey sky above — that skewed the auto colour-sample to grey). thresh moderate so
# the whole gold wordmark+glow is removed but the sample stays gold.
JOBS["starter-riftbound-pack"] = dict(src="starter-riftbound-pack-machine.avif", kind="white",
                                      band=(0.345, 0.625, 0.150, 0.219), color=WHITE, centre=(0.48, 0.166),
                                      twf=0.16, thresh=50, dilate=3)  # ornate → LaMa needs generous coverage
JOBS["black-pack-jjnfuk"] = dict(src="black-pack-jjnfuk-machine.avif", kind="white",
                                 band=(0.35, 0.63, 0.095, 0.172), color=WHITE, centre=(0.49, 0.135), twf=0.165)
JOBS["legend-pack-1dpaec"] = dict(src="legend-pack-1dpaec-machine-src.webp", kind="white",
                                  band=(0.35, 0.63, 0.095, 0.172), color=WHITE, centre=(0.49, 0.135), twf=0.165)
# left bound pulled in off the plate's bright left rim (was catching it → edge smudge); higher
# thresh so only the bright white wordmark is masked, not the dimmer rim.
JOBS["modern-grails-noafw0"] = dict(src="modern-grails-noafw0-machine-src.webp", kind="white",
                                    band=(0.358, 0.602, 0.093, 0.172), color=WHITE, centre=(0.445, 0.135),
                                    twf=0.155, thresh=44)  # left bound off the bright left rim (fixes edge softening); y-top low enough to catch ascender tops; right covers trailing 's' before NBA logo ~0.62
JOBS["pro-soccer-pack"] = dict(src="pro-soccer-pack-machine-src.webp", kind="white",
                               band=(0.35, 0.62, 0.095, 0.165), color=WHITE, centre=(0.485, 0.128), twf=0.155)

DIR = "public/images/claw"
LAMA_IN = "docs/research/packdetail/lama-in"
LAMA_MASK = "docs/research/packdetail/lama-mask"
LAMA_OUT = "docs/research/packdetail/lama-out"
