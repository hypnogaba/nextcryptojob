import { describe, expect, it } from "vitest";
import { prefersSystemShare } from "./share-on-x";

/**
 * Кнопка «Share on X»: системне вікно «Поділитись» має відкриватись лише на телефоні й планшеті.
 * На Mac у Safari `navigator.share` теж є, і клік показував меню AirDrop замість X (власник, 16.09).
 */
function nav(userAgent: string, platform: string, maxTouchPoints = 0): Navigator {
  return { userAgent, platform, maxTouchPoints } as Navigator;
}

const MAC_SAFARI = nav(
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  "MacIntel",
);
const IPHONE = nav("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1", "iPhone", 5);
const IPAD_DESKTOP_MODE = nav("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15", "MacIntel", 5);
const ANDROID = nav("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/128 Mobile Safari/537.36", "Linux armv81", 5);
const WINDOWS = nav("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36", "Win32");

describe("prefersSystemShare", () => {
  it("keeps the desktop on the direct path to X, whatever the browser offers", () => {
    expect(prefersSystemShare(MAC_SAFARI, false)).toBe(false);
    expect(prefersSystemShare(WINDOWS, false)).toBe(false);
    // Миша на екрані з дотиком (ноутбук з тачскрином) це все одно комп'ютер.
    expect(prefersSystemShare(WINDOWS, true)).toBe(false);
  });

  it("gives phones and tablets the system share sheet, where the X app takes the image", () => {
    expect(prefersSystemShare(IPHONE, true)).toBe(true);
    expect(prefersSystemShare(ANDROID, true)).toBe(true);
    // iPad у режимі комп'ютера бреше рядком браузера, видає його лише дотик.
    expect(prefersSystemShare(IPAD_DESKTOP_MODE, true)).toBe(true);
  });
});
