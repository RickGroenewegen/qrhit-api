import { pbCall } from './client';
import type { Host, HostReport } from './types';

export async function publicIp(): Promise<string | null> {
  try {
    const response = await fetch('https://api.ipify.org', { signal: AbortSignal.timeout(5000) });
    return response.ok ? (await response.text()).trim() : null;
  } catch {
    return null;
  }
}

/**
 * `GET /me` on a host: is it reachable from here, does it take the key, and
 * which account is it. The sandbox answers with nginx's own 403 page to IP
 * addresses Print&Bind has not whitelisted, before the API sees the request.
 */
export async function checkHost(target: Host, ip: string | null): Promise<HostReport> {
  const report: HostReport = {
    env: target.env,
    baseUrl: target.baseUrl,
    fingerprint: target.fingerprint,
    reachable: false,
  };
  if (!target.key) {
    report.problem = `no key: set PNB_HARNESS_${target.env.toUpperCase()}_KEY in .env`;
    return report;
  }
  const { fullBody, ...me } = await pbCall(target, 'me', 'GET', '/me');
  report.me = me;
  if (me.status === 200) {
    const data: any = (fullBody as any)?.data ?? {};
    report.reachable = true;
    report.accountId = data.id;
    report.accountName = data.name ?? data.company ?? data.contact;
    return report;
  }
  const html = typeof fullBody === 'string' && /<html|nginx/i.test(fullBody);
  if (me.status === 403 && html) {
    report.problem = `Print&Bind's web server refuses this IP address (nginx 403 before the API)${
      ip ? `: ask Print&Bind to whitelist ${ip}` : ''
    }`;
  } else if (me.status === 401) {
    report.problem = 'the key is refused (401): wrong key for this host?';
  } else if (me.status === null) {
    report.problem = `no answer: ${me.networkError}`;
  } else {
    report.problem = `GET /me answered ${me.status} ${me.statusText}`;
  }
  return report;
}
