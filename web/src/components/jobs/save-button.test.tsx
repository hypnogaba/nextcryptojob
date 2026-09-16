import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { JobCard, type CardJob } from "./job-card";
import { SaveButton } from "./save-button";

/**
 * Власник 16.09, п.5: «Save» була контурною й губилась поруч із чорним "Apply". Тепер вона теж
 * заповнена (те саме чорнило, без нового кольору), а збережений стан має інший, теж помітний фон.
 */
describe("SaveButton", () => {
  it("is filled (not the quiet outline) before saving", () => {
    const html = renderToStaticMarkup(<SaveButton jobRef="nr:1" initialSaved={false} />);
    expect(html).toContain(">Save<");
    expect(html).toContain("bg-primary");
    expect(html).toContain('aria-pressed="false"');
  });

  it("has a distinct, still-filled look once saved, with a visible marker of the state", () => {
    const html = renderToStaticMarkup(<SaveButton jobRef="nr:1" initialSaved />);
    expect(html).toContain("Saved");
    expect(html).toContain('aria-pressed="true"');
    // Не той самий фон, що в незбереженому стані: інакше стан не читається на очі.
    expect(html).not.toContain("bg-primary");
    expect(html).toContain("bg-soft-2");
  });
});

const JOB: CardJob = {
  title: "Protocol engineer",
  company: "Example Labs",
  location: "Remote",
  salary: "$120k to $150k",
  url: "https://example.com/jobs/1",
  postedBy: null,
};

describe("SaveButton inside JobCard (item 5: click must not open the card)", () => {
  it("keeps the whole-card overlay link empty, so it never wraps the Save button", () => {
    const html = renderToStaticMarkup(<JobCard job={JOB} jobRef="nr:1" saved={false} />);
    // Uся картка клікабельна через порожній <a> поверх усього (position:absolute inset-0);
    // Save лежить поруч у окремому шарі, а не всередині цього <a>.
    expect(html).toMatch(/<a[^>]*absolute inset-0[^>]*><\/a>/);
    expect(html).toContain(">Save<");
  });
});
