<#ftl output_format="HTML" auto_esc=true>
<#import "template.ftl" as layout>
<@layout.actionEmail title=msg("emailVerificationSubject") intro=msg("acclimateVerifyIntro") actionLabel=msg("acclimateVerifyAction") actionUrl=link expiry=linkExpirationFormatter(linkExpiration) />
