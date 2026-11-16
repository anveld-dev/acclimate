<#ftl output_format="HTML" auto_esc=true>
<#import "template.ftl" as layout>
<@layout.actionEmail title=msg("passwordResetSubject") intro=msg("acclimateResetIntro") actionLabel=msg("acclimateResetAction") actionUrl=link expiry=linkExpirationFormatter(linkExpiration) />
