import { pickWonRow } from "../roll-pack";

describe("pickWonRow", () => {
  it("returns the row whose cumulative weight crosses zero (basic pick)", () => {
    const rows = [{ weight: 1, id: "a" }, { weight: 0, id: "b" }];
    expect(pickWonRow(rows, 0.5)).toEqual(rows[0]);
  });

  it("returns the last row when roll exceeds total weight", () => {
    const rows = [{ weight: 1, id: "a" }, { weight: 1, id: "b" }];
    // roll=99 far exceeds totalWeight=2, so the loop exhausts and won stays as last
    expect(pickWonRow(rows, 99)).toEqual(rows[rows.length - 1]);
  });

  it("picks correctly with weighted distribution", () => {
    // weight=[70,30], roll<70 → first row
    const rows = [{ weight: 70, id: "common" }, { weight: 30, id: "rare" }];
    expect(pickWonRow(rows, 0)).toEqual(rows[0]);   // roll=0: 0-70 < 0 → first
    expect(pickWonRow(rows, 65)).toEqual(rows[0]);  // roll=65: 65-70=-5 < 0 → first
    expect(pickWonRow(rows, 70)).toEqual(rows[1]);  // roll=70: 70-70=0, not <0; 0-30=-30 < 0 → second
    expect(pickWonRow(rows, 99)).toEqual(rows[1]);  // past total → last
  });
});
