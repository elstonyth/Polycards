import {
  USERNAME_MAX,
  USERNAME_RE,
  generatedUsername,
  isValidUsername,
  normalizeUsername,
  publicProfileFields,
  sanitizeUsername,
  storedHandle,
  suffixedUsername,
} from "../profile-handle";

// A customer has a display name (changeable) and a permanent profile handle
// (the URL). Both share these rules: a fixed ASCII charset so a value is a URL
// segment without encoding, and a case fold so two people can never hold what
// reads as one name or one link.

describe("USERNAME_RE", () => {
  it("accepts the shapes real display names take", () => {
    expect("MOONBREON").toMatch(USERNAME_RE); // uppercase is a DISPLAY name
    expect("ash_red").toMatch(USERNAME_RE);
    expect("EvOlViNg_CrIeS").toMatch(USERNAME_RE);
    expect("Wei-Nguan").toMatch(USERNAME_RE);
    expect("Collector4809").toMatch(USERNAME_RE);
  });

  it("rejects anything that would not survive a URL intact", () => {
    expect("has space").not.toMatch(USERNAME_RE);
    expect("爱动漫的").not.toMatch(USERNAME_RE);
    expect("semi;colon").not.toMatch(USERNAME_RE);
    expect("slash/es").not.toMatch(USERNAME_RE);
    expect("per%cent").not.toMatch(USERNAME_RE);
    expect("ab").not.toMatch(USERNAME_RE); // too short
    expect("x".repeat(USERNAME_MAX + 1)).not.toMatch(USERNAME_RE);
  });
});

describe("normalizeUsername", () => {
  it("folds case and trims — the one comparison key", () => {
    expect(normalizeUsername("  MOONBREON ")).toBe("moonbreon");
    expect(normalizeUsername("Moonbreon")).toBe(normalizeUsername("MOONBREON"));
  });
});

describe("isValidUsername", () => {
  it("tolerates surrounding whitespace but not internal", () => {
    expect(isValidUsername("  Kenji  ")).toBe(true);
    expect(isValidUsername("Ke nji")).toBe(false);
    expect(isValidUsername(null)).toBe(false);
    expect(isValidUsername(42)).toBe(false);
  });
});

describe("sanitizeUsername", () => {
  it("coerces a human name into the charset", () => {
    expect(sanitizeUsername("Wei Nguan")).toBe("Wei_Nguan");
    expect(sanitizeUsername("Mira O'Neill")).toBe("Mira_O_Neill");
    expect(sanitizeUsername("  dope tcg collectibles ")).toBe(
      "dope_tcg_collectibles",
    );
  });

  it("returns null when nothing usable survives", () => {
    expect(sanitizeUsername("爱动漫的")).toBeNull(); // no ASCII at all
    expect(sanitizeUsername("")).toBeNull();
    expect(sanitizeUsername(null)).toBeNull();
    expect(sanitizeUsername("__")).toBeNull(); // separators only
    expect(sanitizeUsername("ab")).toBeNull(); // under the minimum
  });

  it("never emits something the write gate would then reject", () => {
    for (const raw of [
      "Wei Nguan",
      "x".repeat(200),
      "!!!alpha!!!",
      "a b c d e f g h i j k l m n o p q r s t",
    ]) {
      const out = sanitizeUsername(raw);
      if (out !== null) expect(out).toMatch(USERNAME_RE);
    }
  });
});

describe("generatedUsername", () => {
  it("is deterministic per customer and looks like any other name", () => {
    expect(generatedUsername("cus_01ABCDEF")).toBe(
      generatedUsername("cus_01ABCDEF"),
    );
    expect(generatedUsername("cus_01ABCDEF")).toMatch(USERNAME_RE);
    expect(generatedUsername("cus_01ABCDEF")).toMatch(/^Collector\d{4}$/);
  });
});

describe("suffixedUsername", () => {
  it("varies with the attempt so a retry is a NEW candidate", () => {
    const a = suffixedUsername("Tan", "cus_1", 0);
    const b = suffixedUsername("Tan", "cus_1", 1);
    expect(a).not.toBe(b);
    expect(a).toBe(suffixedUsername("Tan", "cus_1", 0)); // deterministic
  });

  it("keeps the stem readable", () => {
    expect(suffixedUsername("Tan", "cus_1", 0)).toMatch(/^Tan\d{4}$/);
  });

  it("truncates a long stem instead of overflowing the limit", () => {
    // The regression this guards: appending blindly produces a candidate the
    // write gate rejects, turning a name collision into a 500.
    const out = suffixedUsername("x".repeat(USERNAME_MAX), "cus_1", 0);
    expect(out.length).toBeLessThanOrEqual(USERNAME_MAX);
    expect(out).toMatch(USERNAME_RE);
  });

  it("never leaves a trailing separator where it cut", () => {
    const out = suffixedUsername(`${"a".repeat(25)}___________`, "cus_1", 0);
    expect(out).toMatch(USERNAME_RE);
    expect(out).not.toMatch(/[_-]\d{4}$/);
  });
});

describe("storedHandle", () => {
  it("reads the permanent handle out of metadata", () => {
    expect(storedHandle({ metadata: { handle: "Collector6167" } })).toBe(
      "Collector6167",
    );
  });

  it("is null before one is assigned, or when the stored value is unusable", () => {
    expect(storedHandle(undefined)).toBeNull();
    expect(storedHandle({ metadata: null })).toBeNull();
    expect(storedHandle({ metadata: {} })).toBeNull();
    expect(storedHandle({ metadata: { handle: "has space" } })).toBeNull();
    expect(storedHandle({ metadata: { handle: 42 } })).toBeNull();
  });
});

describe("publicProfileFields", () => {
  // The reported case (2026-09-30): an account first named Collector6167
  // that renamed after its Immortal pull went out on Telegram. The post's
  // link has to keep resolving, so it is the handle — never the name.
  it("shows the display name but links the permanent handle", () => {
    expect(
      publicProfileFields(
        { first_name: "MOONBREON", metadata: { handle: "Collector6167" } },
        12345,
      ),
    ).toEqual({ name: "MOONBREON", handle: "Collector6167", avatarUrl: null });
  });

  it("links nothing until a handle is assigned — not even a URL-safe name", () => {
    // Falling back to the display name would mint exactly the link a rename
    // retires.
    const { name, handle } = publicProfileFields(
      { first_name: "MOONBREON", metadata: {} },
      98765,
    );
    expect(name).toBe("MOONBREON");
    expect(handle).toBeNull();
  });

  it("anonymises a nameless customer and links nothing", () => {
    expect(publicProfileFields(undefined, 98765)).toEqual({
      name: "Collector 9876",
      handle: null,
      avatarUrl: null,
    });
  });

  it("passes through a stored avatar url", () => {
    expect(
      publicProfileFields(
        { first_name: "Kenji", metadata: { avatar_url: "/a.webp" } },
        1,
      ).avatarUrl,
    ).toBe("/a.webp");
  });
});
