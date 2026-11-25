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
                && (allowed || !v.is_private() && !matches!(v.octets(), [100, 64..=127, _, _]))
        }
        IpAddr::V6(v) => {
            !v.is_unicast_link_local()
                && v.segments() != [0xfd00, 0xec2, 0, 0, 0, 0, 0, 0x254]
                && (allowed || !v.is_unique_local())
        }
    }
}

pub const MALFORMED: &str = "The provider base URL is not a valid address. Enter a full URL such as https://api.example.com/v1.";
pub const HTTP_NOT_LISTED: &str = "Plain HTTP is allowed only for hosts listed in ACCLIMATE_PROVIDER_HTTP_HOSTS on the service and the executor. Use https, or ask an operator to list this host.";
pub const EXTRA_PARTS: &str =
    "Remove the user name, password, query or fragment from the provider base URL.";
pub const PRIVATE_NOT_LISTED: &str = "The provider base URL points to a private or local address. To allow it, an operator must list the host in ACCLIMATE_PROVIDER_HTTP_HOSTS on the service and the executor.";
pub const RESERVED: &str = "The provider base URL points to a reserved or cloud metadata address, which is never allowed. Use the provider's own address.";

pub fn validate_endpoint(endpoint: &str, allowlist: &str) -> Result<()> {
    let refuse = |message: &str| Error::new(ErrorKind::InvalidInput, message.to_owned());
    let url = reqwest::Url::parse(endpoint).map_err(|_| refuse(MALFORMED))?;
    let host = url
        .host_str()
        .ok_or_else(|| refuse(MALFORMED))?
        .trim_matches(['[', ']'])
        .trim_end_matches('.');
    let allowed = host_allowed(host, allowlist);
    match url.scheme() {
        "https" => {}
        "http" if allowed => {}
        "http" => return Err(refuse(HTTP_NOT_LISTED)),
        _ => return Err(refuse(MALFORMED)),
    }
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(refuse(EXTRA_PARTS));
    }
    let ip = host.parse::<IpAddr>().ok();
    if matches!(host, "metadata.google.internal" | "metadata.goog")
        || ip.is_some_and(|ip| !address_allowed(ip, true))
    {
        return Err(refuse(RESERVED));
    }
    if ip.is_some_and(|ip| !address_allowed(ip, allowed))
        || !allowed && (host == "localhost" || host.ends_with(".localhost"))
    {
        return Err(refuse(PRIVATE_NOT_LISTED));
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
        let message =
            |url: &str, allowlist: &str| validate_endpoint(url, allowlist).unwrap_err().to_string();
        for (url, expected) in [
            ("https://10.0.0.1", PRIVATE_NOT_LISTED),
            ("https://100.64.0.1", PRIVATE_NOT_LISTED),
            ("https://[fe80::1]", RESERVED),
            ("http://example.org", HTTP_NOT_LISTED),
            ("https://localhost", PRIVATE_NOT_LISTED),
            ("https://[::ffff:127.0.0.1]", PRIVATE_NOT_LISTED),
            ("https://169.254.169.254", RESERVED),
            ("https://[fd00:ec2::254]", RESERVED),
            ("https://100.100.100.200", RESERVED),
            ("https://metadata.google.internal", RESERVED),
            ("not a url", MALFORMED),
            ("ftp://example.org", MALFORMED),
            ("https://user@example.org", EXTRA_PARTS),
            ("https://example.org/v1?x=1", EXTRA_PARTS),
        ] {
            assert_eq!(message(url, "169.254.169.254"), expected, "{url}");
        }
        assert!(validate_endpoint("http://cliproxy:8317/v1", "cliproxy").is_ok());
    }
}
