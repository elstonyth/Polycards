import { priceFieldForGrade, gradeToGrader, PRICE_FIELDS } from "../pricecharting-grades";

test("maps labels to fields", () => {
  expect(priceFieldForGrade("PSA 10")).toBe("manual-only-price");
  expect(priceFieldForGrade("BGS 10")).toBe("bgs-10-price");
  expect(priceFieldForGrade("Ungraded")).toBe("loose-price");
  expect(priceFieldForGrade("nope")).toBeNull();
});

test("splits graded tiers, blanks generic grader", () => {
  expect(gradeToGrader("PSA 10")).toEqual({ grader: "PSA", grade: "10" });
  expect(gradeToGrader("Grade 9.5")).toEqual({ grader: "", grade: "9.5" });
  expect(gradeToGrader("Ungraded")).toEqual({ grader: "", grade: "Ungraded" });
});

test("nine tiers ascending", () => {
  expect(PRICE_FIELDS.map(([, l]) => l)).toEqual([
    "Ungraded", "Grade 7", "Grade 8", "Grade 9", "Grade 9.5", "PSA 10", "BGS 10", "CGC 10", "SGC 10"]);
});
