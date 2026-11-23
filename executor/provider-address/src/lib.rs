use std::io::{Error, ErrorKind, Result};
use std::net::IpAddr;

pub fn host_allowed(host: &str, allowlist: &str) -> bool {
    allowlist.split(',').any(|s| {
        !s.trim().is_empty()
            && s.trim()
                .eq_ignore_ascii_case(host.trim_matches(['[', ']']).trim_end_matches('.'))
    })
}

pub fn address_allowed(ip: IpAddr, allowed: bool) -> bool {
    let ip = ip.to_canonical();
    if ip.is_unspecified() || ip.is_multicast() || (!allowed && ip.is_loopback()) {
        return false;
    }
    match ip {
        IpAddr::V4(v) => {
            !v.is_link_local()
                && !v.is_broadcast()
                && !matches!(v.octets(), [100, 100, 100, 200] | [168, 63, 129, 16])
                && (allowed || !v.is_private())
        }
        IpAddr::V6(v) => {
            !v.is_unicast_link_local()
                && v.segments() != [0xfd00, 0xec2, 0, 0, 0, 0, 0, 0x254]
                && (allowed || !v.is_unique_local())
        }
    }
}

pub fn validate_endpoint(endpoint: &str, allowlist: &str) -> Result<()> {
    let invalid = || Error::new(ErrorKind::InvalidInput, "invalid provider endpoint");
    let url = reqwest::Url::parse(endpoint).map_err(|_| invalid())?;
    let host = url
        .host_str()
        .ok_or_else(invalid)?
        .trim_matches(['[', ']'])
        .trim_end_matches('.');
    let allowed = host_allowed(host, allowlist);
    if !(url.scheme() == "https" || url.scheme() == "http" && allowed)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid());
    }
    if matches!(host, "metadata.google.internal" | "metadata.goog")
        || host
            .parse::<IpAddr>()
            .is_ok_and(|ip| !address_allowed(ip, allowed))
        || !allowed && (host == "localhost" || host.ends_with(".localhost"))
    {
        return Err(invalid());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn provider_addresses() {
        assert!(validate_endpoint("https://example.org", "").is_ok());
        assert!(validate_endpoint("http://127.0.0.1", "127.0.0.1").is_ok());
        for url in [
            "https://10.0.0.1",
            "https://[fe80::1]",
            "http://example.org",
            "https://localhost",
            "https://[::ffff:127.0.0.1]",
            "https://169.254.169.254",
            "https://[fd00:ec2::254]",
            "https://100.100.100.200",
        ] {
            assert!(validate_endpoint(url, "169.254.169.254").is_err(), "{url}");
        }
        assert!(validate_endpoint("http://cliproxy:8317/v1", "cliproxy").is_ok());
    }
}
