<#ftl output_format="HTML" auto_esc=true>
<#macro emailLayout>
<!doctype html>
<html lang="${locale.language}" dir="${(ltr)?then('ltr','rtl')}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:0;background:#fafafa;color:#0a0a0a;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;"><tr><td align="center" style="padding:32px 16px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;table-layout:fixed;">
      <tr><td style="padding:0 0 24px;font-size:20px;font-weight:650;letter-spacing:-0.5px;">Acclimate</td></tr>
      <tr><td style="background:#ffffff;border:1px solid #e5e5e5;border-radius:8px;padding:32px;font-size:16px;line-height:1.6;overflow-wrap:anywhere;word-break:break-word;"><#nested></td></tr>
      <tr><td style="padding:20px 0;color:#525252;font-size:12px;line-height:1.6;">${msg("acclimateIgnore")}</td></tr>
    </table>
  </td></tr></table>
</body>
</html>
</#macro>

<#macro actionEmail title intro actionLabel actionUrl expiry>
<@emailLayout>
  <p style="margin:0 0 20px;color:#525252;font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;">${msg("acclimateAccount")}</p>
  <h1 style="margin:0 0 16px;font-size:28px;line-height:1.25;letter-spacing:-0.7px;">${title}</h1>
  <p style="margin:0 0 28px;color:#525252;font-size:16px;line-height:1.6;">${intro}</p>
  <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="background:#0a0a0a;border-radius:6px;"><a href="${actionUrl}" style="display:inline-block;padding:14px 22px;border:1px solid #0a0a0a;border-radius:6px;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;">${actionLabel} &rarr;</a></td></tr></table>
  <p style="margin:24px 0 0;color:#525252;font-size:13px;line-height:1.6;">${msg("acclimateExpiry", expiry)}</p>
  <p style="margin:16px 0 0;color:#525252;font-size:13px;line-height:1.6;">${msg("acclimateButtonHelp")} <a href="${actionUrl}" style="color:#0a0a0a;text-decoration:underline;">${msg("acclimateOpenLink")}</a>.</p>
</@emailLayout>
</#macro>
