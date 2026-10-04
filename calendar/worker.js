// 모아보는 달력 — 일정 가져오기 중계기 (Cloudflare Worker)
//
// 왜 필요한가: 구글·애플·네이버 캘린더 서버는 브라우저가 다른 사이트에서 직접 읽어 가는 걸
// 막아 둔다(CORS). 그래서 이 작은 중계기가 대신 받아서 달력 페이지에 넘겨준다.
// 받은 일정은 저장하지 않고 그대로 돌려줄 뿐이다.
//
// 설치: Cloudflare 대시보드 → Workers → 새 Worker → 이 파일 내용을 붙여넣고 배포
//       → 설정 → 변수에 ACCESS_KEY(아무 긴 문자열)를 '암호화'로 추가.
//       달력 페이지 설정에 Worker 주소와 같은 ACCESS_KEY를 넣으면 된다.
//
// 두 가지 길:
//   GET  /ics?url=<iCal 주소>          구글 '비밀 주소(iCal 형식)', 공개 캘린더 등
//   POST /caldav {server, username, password, start, end}
//                                       애플 iCloud·네이버처럼 CalDAV 로 여는 계정
//
// ⚠️ ACCESS_KEY 가 없으면 아무나 이 Worker 를 프록시로 쓸 수 있으므로 모든 요청을 거절한다.

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors() });

    const url = new URL(request.url);
    try {
      if (!env.ACCESS_KEY) return json({ error: 'Worker 에 ACCESS_KEY 가 설정되지 않았습니다' }, 500);
      if (request.headers.get('X-Access-Key') !== env.ACCESS_KEY) {
        return json({ error: '접근 키가 맞지 않습니다' }, 401);
      }

      if (url.pathname === '/ics' && request.method === 'GET') {
        return await handleIcs(url.searchParams.get('url'));
      }
      if (url.pathname === '/caldav' && request.method === 'POST') {
        return await handleCaldav(await request.json());
      }
      return json({ error: '없는 경로입니다' }, 404);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 502);
    }
  },
};

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Access-Key',
    'Access-Control-Max-Age': '86400',
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors() },
  });
}

// ── iCal 주소 ───────────────────────────────────────────────

async function handleIcs(raw) {
  if (!raw) return json({ error: 'url 이 비었습니다' }, 400);
  // 애플·구글이 주는 webcal:// 은 https 로 바꿔 받는다
  const target = new URL(raw.replace(/^webcals?:\/\//i, 'https://'));
  if (target.protocol !== 'https:') return json({ error: 'https 주소만 받습니다' }, 400);

  const res = await fetch(target.toString(), {
    headers: { 'User-Agent': 'moa-calendar/1.0', Accept: 'text/calendar, */*' },
    redirect: 'follow',
  });
  const text = await res.text();
  if (!res.ok) return json({ error: `캘린더 서버가 ${res.status} 로 답했습니다` }, 502);
  if (!text.includes('BEGIN:VCALENDAR')) return json({ error: 'iCal 형식이 아닙니다. 주소를 확인해 주세요' }, 502);
  return new Response(text, {
    headers: { 'Content-Type': 'text/calendar; charset=utf-8', ...cors() },
  });
}

// ── CalDAV ──────────────────────────────────────────────────
// 순서: 주소 → 내 principal → 캘린더 홈 → 캘린더 목록 → 기간 안 일정(REPORT)

async function handleCaldav({ server, username, password, start, end }) {
  if (!server || !username || !password) return json({ error: '서버·아이디·비밀번호가 필요합니다' }, 400);
  const base = new URL(server);
  if (base.protocol !== 'https:') return json({ error: 'https 주소만 받습니다' }, 400);
  const auth = 'Basic ' + btoa(unescape(encodeURIComponent(`${username}:${password}`)));

  // href 는 항상 그것을 알려 준 응답 주소 기준으로 푼다 — iCloud 는 중간에 호스트가 바뀐다
  const dav = async (target, method, body, depth) => {
    const res = await fetch(target, {
      method,
      headers: {
        Authorization: auth,
        'Content-Type': 'application/xml; charset=utf-8',
        Depth: String(depth),
        'User-Agent': 'moa-calendar/1.0',
      },
      body,
      redirect: 'follow',
    });
    if (res.status === 401) throw new Error('아이디나 앱 비밀번호가 맞지 않습니다');
    if (!res.ok && res.status !== 207) throw new Error(`CalDAV 서버가 ${res.status} 로 답했습니다 (${method})`);
    return { xml: await res.text(), url: res.url || target };
  };

  // 1) principal
  const principalQuery = `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>`;
  let p1;
  try {
    p1 = await dav(base.toString(), 'PROPFIND', principalQuery, 0);
  } catch (e) {
    // 루트에서 답을 안 주는 서버는 표준 길(RFC 6764)로 한 번 더 찾는다. 비밀번호 오류는 그대로 알린다
    if (/비밀번호/.test(e.message)) throw e;
    p1 = await dav(new URL('/.well-known/caldav', base).toString(), 'PROPFIND', principalQuery, 0);
  }
  const principalHref = firstHref(p1.xml, 'current-user-principal');
  const principal = principalHref ? new URL(principalHref, p1.url).toString() : p1.url;

  // 2) calendar-home-set (iCloud 는 다른 호스트 p01-caldav.icloud.com 등을 줄 수 있다)
  const p2 = await dav(principal, 'PROPFIND',
    `<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-home-set/></d:prop></d:propfind>`, 0);
  const homeHref = firstHref(p2.xml, 'calendar-home-set');
  const home = homeHref ? new URL(homeHref, p2.url).toString() : p2.url;

  // 3) 캘린더 목록
  const p3 = await dav(home, 'PROPFIND',
    `<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/">` +
    `<d:prop><d:resourcetype/><d:displayname/><a:calendar-color/><c:supported-calendar-component-set/></d:prop></d:propfind>`, 1);
  const calendars = responses(p3.xml)
    .filter(r => /<[^>]*calendar[\s/>]/i.test(tagInner(r, 'resourcetype') || ''))
    .filter(r => {
      const comps = tagInner(r, 'supported-calendar-component-set');
      return !comps || /VEVENT/i.test(comps); // 할 일(VTODO) 전용 목록은 뺀다
    })
    .map(r => ({
      href: new URL(decodeXml(tagInner(r, 'href') || '').trim() || '.', p3.url).toString(),
      name: decodeXml(tagInner(r, 'displayname') || '').trim() || '캘린더',
      color: (tagInner(r, 'calendar-color') || '').trim().slice(0, 7) || null,
    }))
    .filter(c => c.href !== p3.url);

  // 4) 기간 안 일정 — 반복 일정은 원본(RRULE)을 그대로 받고 펼치기는 페이지가 한다
  const range = `start="${toCaldavTime(start)}" end="${toCaldavTime(end)}"`;
  const query =
    `<?xml version="1.0"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">` +
    `<d:prop><c:calendar-data/></d:prop>` +
    `<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range ${range}/>` +
    `</c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;

  const out = [];
  for (const cal of calendars) {
    try {
      const r = await dav(cal.href, 'REPORT', query, 1);
      const ics = responses(r.xml)
        .map(x => decodeXml(tagInner(x, 'calendar-data') || ''))
        .filter(s => s.includes('BEGIN:VCALENDAR'));
      out.push({ ...cal, ics });
    } catch (e) {
      out.push({ ...cal, ics: [], error: String(e.message || e) });
    }
  }
  return json({ calendars: out });
}

// 네임스페이스 접두어(d:, D:, cal: …)가 서버마다 달라서 정규식으로 느슨하게 읽는다
function tagInner(xml, local) {
  const re = new RegExp(`<(?:[\\w-]+:)?${local}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${local}>`, 'i');
  const m = xml.match(re);
  return m ? m[1] : null;
}
function firstHref(xml, local) {
  const inner = tagInner(xml, local);
  return inner ? decodeXml(tagInner(inner, 'href') || '').trim() || null : null;
}
function responses(xml) {
  return xml.match(/<(?:[\w-]+:)?response(?:\s[^>]*)?>[\s\S]*?<\/(?:[\w-]+:)?response>/gi) || [];
}
function decodeXml(s) {
  return s
    .replace(/^\s*<!\[CDATA\[([\s\S]*)\]\]>\s*$/, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#13;/g, '\r').replace(/&#10;/g, '\n')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&amp;/g, '&');
}
function toCaldavTime(iso) {
  const d = iso ? new Date(iso) : new Date();
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}
