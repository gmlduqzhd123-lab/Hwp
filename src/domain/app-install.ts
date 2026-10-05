// 앱 설치(홈 화면에 추가) 안내. 브라우저 정보만 읽고 문서 데이터와는 관계가 없다.

export type InstallEnvironment = 'kakao' | 'in-app' | 'ios-safari' | 'ios-other' | 'android' | 'firefox' | 'mac-safari' | 'desktop';

export interface InstallGuide {
  environment: InstallEnvironment;
  /** 안내 첫 문장. 없으면 단계만 보여 준다. */
  lead: string | null;
  steps: string[];
  note: string | null;
  /** 카카오톡에서 기본 브라우저로 다시 여는 버튼 문구 */
  openExternalLabel: string | null;
}

export interface BrowserTraits {
  userAgent: string;
  platform: string;
  maxTouchPoints: number;
}

export function detectInstallEnvironment({ userAgent: ua, platform, maxTouchPoints }: BrowserTraits): InstallEnvironment {
  const ios = /iphone|ipad|ipod/i.test(ua) || (platform === 'MacIntel' && maxTouchPoints > 1);
  if (/KAKAOTALK/i.test(ua)) return 'kakao';
  if (/NAVER\(inapp|Instagram|FBAN|FBAV|Line\/|DaumApps|everytimeApp|; wv\)/i.test(ua)) return 'in-app';
  if (ios) return /Safari/i.test(ua) && !/CriOS|FxiOS|EdgiOS|Whale/i.test(ua) ? 'ios-safari' : 'ios-other';
  if (/android/i.test(ua)) return 'android';
  if (/Firefox/i.test(ua)) return 'firefox';
  if (/Safari/i.test(ua) && !/Chrome|Chromium|Edg/i.test(ua)) return 'mac-safari';
  return 'desktop';
}

export function installGuide(traits: BrowserTraits): InstallGuide {
  const environment = detectInstallEnvironment(traits);
  const ios = environment === 'ios-safari' || environment === 'ios-other'
    || /iphone|ipad|ipod/i.test(traits.userAgent) || (traits.platform === 'MacIntel' && traits.maxTouchPoints > 1);
  const samsung = /SamsungBrowser/i.test(traits.userAgent);
  switch (environment) {
    case 'kakao':
      return {
        environment, openExternalLabel: ios ? 'Safari로 열기' : '브라우저로 열기',
        lead: `카카오톡 안에서 연 화면에서는 앱을 설치할 수 없어요. 아래 버튼으로 ${ios ? 'Safari' : '인터넷 브라우저'}에서 다시 열어 주세요.`,
        steps: [], note: `버튼이 안 되면 카카오톡 화면의 ⋮ 메뉴에서 ‘${ios ? 'Safari로 열기' : '다른 브라우저로 열기'}’를 누른 뒤 앱 설치를 다시 눌러 주세요.`,
      };
    case 'in-app':
      return {
        environment, openExternalLabel: null, lead: '이 앱(인앱 브라우저) 안에서는 설치할 수 없어요.',
        steps: ['화면의 ⋮ 또는 ⋯ 메뉴를 누르세요.', `‘${ios ? 'Safari로 열기' : '다른 브라우저로 열기'}’를 누르세요.`, '열린 화면에서 앱 설치를 다시 눌러 주세요.'], note: null,
      };
    case 'ios-safari':
      return {
        environment, openExternalLabel: null, lead: null,
        steps: ['Safari 아래쪽(아이패드는 위쪽) 공유 버튼(□↑)을 누르세요.', '목록을 내려 ‘홈 화면에 추가’를 누르세요.', '오른쪽 위 ‘추가’를 누르면 홈 화면에 아이콘이 생겨요.'], note: null,
      };
    case 'ios-other':
      return {
        environment, openExternalLabel: null, lead: '아이폰·아이패드는 Safari에서 설치하는 것이 가장 확실해요.',
        steps: ['이 주소를 Safari에서 열어 주세요.', '아래쪽 공유 버튼(□↑)을 누르세요.', '‘홈 화면에 추가’ → ‘추가’를 누르세요.'], note: null,
      };
    case 'android':
      return {
        environment, openExternalLabel: null, lead: null,
        steps: [`브라우저 ${samsung ? '아래쪽 ≡ 메뉴' : '오른쪽 위 ⋮ 메뉴'}를 누르세요.`, '‘앱 설치’ 또는 ‘홈 화면에 추가’를 누르세요.', '‘설치(추가)’를 누르면 홈 화면에 아이콘이 생겨요.'],
        note: '메뉴에 설치 항목이 없으면 크롬이나 삼성 인터넷으로 열어 주세요.',
      };
    case 'firefox':
      return { environment, openExternalLabel: null, lead: '파이어폭스는 앱 설치를 지원하지 않아요. 크롬이나 엣지로 이 주소를 열고 다시 눌러 주세요.', steps: [], note: null };
    case 'mac-safari':
      return { environment, openExternalLabel: null, lead: null, steps: ['Safari 메뉴 막대의 ‘파일’ 메뉴(또는 공유 버튼)를 누르세요.', '‘Dock에 추가’를 누르세요.'], note: null };
    default:
      return {
        environment, openExternalLabel: null, lead: null,
        steps: ['주소창 오른쪽의 설치 아이콘(⊕ 또는 🖥️)을 누르세요.', '안 보이면 오른쪽 위 ⋮ 메뉴 → ‘앱 설치’(엣지는 ⋯ → 앱 → ‘이 사이트를 앱으로 설치’)를 누르세요.'],
        note: '이미 설치했다면 바탕화면이나 시작 메뉴에서 열 수 있어요.',
      };
  }
}

/** 카카오톡 인앱 브라우저에서 같은 화면을 기본 브라우저로 여는 주소. 문서 데이터는 담지 않는다. */
export function kakaoOpenExternalUrl(pageUrl: string): string {
  const url = new URL(pageUrl);
  url.hash = '';
  return `kakaotalk://web/openExternal?url=${encodeURIComponent(url.href)}`;
}
