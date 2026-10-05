import { describe, expect, it } from 'vitest';
import { detectInstallEnvironment, installGuide, kakaoOpenExternalUrl } from '../../src/domain/app-install';

const UA = {
  iphoneSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  iphoneChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0 Mobile/15E148 Safari/604.1',
  ipadDesktopMode: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  kakaoAndroid: 'Mozilla/5.0 (Linux; Android 14; SM-S921N; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0 Mobile Safari/537.36 KAKAOTALK 10.8.0',
  kakaoIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 KAKAOTALK 10.8.0',
  naverApp: 'Mozilla/5.0 (Linux; Android 14; SM-S921N; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0 Mobile Safari/537.36 NAVER(inapp; search; 2000; 12.0.0)',
  samsung: 'Mozilla/5.0 (Linux; Android 14; SM-S921N) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0 Mobile Safari/537.36',
  windowsChrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36',
  firefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0',
};
const traits = (userAgent: string, platform = 'Linux armv8l', maxTouchPoints = 5) => ({ userAgent, platform, maxTouchPoints });

describe('app install guidance', () => {
  it.each([
    [traits(UA.iphoneSafari, 'iPhone'), 'ios-safari'],
    [traits(UA.iphoneChrome, 'iPhone'), 'ios-other'],
    [traits(UA.ipadDesktopMode, 'MacIntel', 5), 'ios-safari'],
    [traits(UA.ipadDesktopMode, 'MacIntel', 0), 'mac-safari'],
    [traits(UA.kakaoAndroid), 'kakao'],
    [traits(UA.kakaoIphone, 'iPhone'), 'kakao'],
    [traits(UA.naverApp), 'in-app'],
    [traits(UA.samsung), 'android'],
    [traits(UA.windowsChrome, 'Win32', 0), 'desktop'],
    [traits(UA.firefox, 'Win32', 0), 'firefox'],
  ] as const)('classifies %# as %s', (browser, expected) => {
    expect(detectInstallEnvironment(browser)).toBe(expected);
  });

  it('offers the KakaoTalk external-browser button with the platform browser name', () => {
    expect(installGuide(traits(UA.kakaoIphone, 'iPhone')).openExternalLabel).toBe('Safari로 열기');
    expect(installGuide(traits(UA.kakaoAndroid)).openExternalLabel).toBe('브라우저로 열기');
    expect(installGuide(traits(UA.iphoneSafari, 'iPhone')).openExternalLabel).toBeNull();
  });

  it('names the Samsung Internet menu location', () => {
    expect(installGuide(traits(UA.samsung)).steps[0]).toContain('아래쪽 ≡ 메뉴');
    expect(installGuide(traits(UA.windowsChrome, 'Win32', 0)).steps.length).toBeGreaterThan(0);
  });

  it('builds the KakaoTalk link from the page address without the hash route', () => {
    expect(kakaoOpenExternalUrl('https://gmlduqzhd123-lab.github.io/Hwp/#/workspace'))
      .toBe('kakaotalk://web/openExternal?url=https%3A%2F%2Fgmlduqzhd123-lab.github.io%2FHwp%2F');
  });
});
