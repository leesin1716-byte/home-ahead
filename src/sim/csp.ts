// MCP Apps 뷰 HTML 에 뷰가 선언한 CSP(_meta.ui.csp)를 meta 태그로 박아 호스트가 네트워크 접근을 막게 한다

/**
 * Enforce the CSP a view declares (MCP Apps `_meta.ui.csp`): no network unless it lists a domain.
 * The sandbox already blocks same-origin access; this also blocks fetch, images and fonts from elsewhere.
 */
export function withCsp(html: string, csp: { connectDomains?: string[]; resourceDomains?: string[] } = {}): string {
  const res = (csp.resourceDomains ?? []).join(' ');
  const connect = csp.connectDomains?.length ? csp.connectDomains.join(' ') : "'none'";
  const policy = [
    "default-src 'none'",
    `script-src 'unsafe-inline' ${res}`.trim(),
    `style-src 'unsafe-inline' ${res}`.trim(),
    `img-src data: ${res}`.trim(),
    `font-src data: ${res}`.trim(),
    `connect-src ${connect}`,
  ].join('; ');
  const meta = `<meta http-equiv="Content-Security-Policy" content="${policy.replace(/"/g, '&quot;')}">`;
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (h) => h + meta) : meta + html;
}
