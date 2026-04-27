import dns from 'node:dns';

export function preferIpv4Dns() {
    try {
        dns.setDefaultResultOrder('ipv4first');
    } catch {
        // Older Node versions may not support this setting.
    }
}
