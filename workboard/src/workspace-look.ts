export const WORKSPACE_LOOK: Record<
  string,
  { initials: string; color: string; soft: string; description: string }
> = {
  "asty-cabin": {
    initials: "AC",
    color: "#32705d",
    soft: "#e8f1ec",
    description: "서울 장기 체류자를 위한 숙소·생활 가이드",
  },
  "korea-buy-list": {
    initials: "BL",
    color: "#b97039",
    soft: "#fff1e4",
    description: "영어·일본어 독자를 위한 한국 쇼핑 가이드",
  },
  koreabylocal: {
    initials: "KL",
    color: "#457b9d",
    soft: "#eaf2f8",
    description: "현지의 시선으로 전하는 한국 여행과 경험",
  },
  koreadecode: {
    initials: "KD",
    color: "#7966a5",
    soft: "#f0ecf8",
    description: "세계의 독자에게 풀어주는 한국 문화와 트렌드",
  },
};
export function workspaceLook(id: string) {
  return (
    WORKSPACE_LOOK[id] ?? {
      initials: id.slice(0, 2).toUpperCase(),
      color: "#32705d",
      soft: "#e8f1ec",
      description: "연결된 블로그 워크스페이스",
    }
  );
}
export const LANGUAGE_LABEL: Record<string, string> = {
  en: "영어",
  ja: "일본어",
  "zh-hans": "중국어",
};
