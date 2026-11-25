#!/bin/sh
# Write the private settings and secrets for a new single-host deployment.
# Usage: deploy/init.sh --domain example.com --email you@example.com [options]
set -eu

usage() {
	cat <<'EOF'
Usage: deploy/init.sh --domain DOMAIN --email EMAIL [options]

Writes the private directory with every secret, and the checkout's .env.
Then run: docker compose up -d --build --wait

  --domain DOMAIN       Derives console.DOMAIN, api.DOMAIN and auth.DOMAIN
  --email EMAIL         Your email: the first person's Keycloak login and the
                        certificate contact address
  --console-host HOST   Public console hostname (default console.DOMAIN)
  --api-host HOST       Public API hostname (default api.DOMAIN)
  --auth-host HOST      Public Keycloak hostname (default auth.DOMAIN)
  --version VERSION     Image tag, such as 0.1.0 (default local, built from
                        this checkout)
  --config-dir DIR      Private directory (default ~/.config/acclimate)
EOF
}

fail() {
	printf 'deploy/init.sh: %s\n' "$1" >&2
	exit 1
}

domain='' email='' console_host='' api_host='' auth_host='' version=local
config_dir="${HOME:?HOME is not set}/.config/acclimate"
while [ "$#" -gt 0 ]; do
	case "$1" in
	-h | --help)
		usage
		exit 0
		;;
	--domain | --email | --console-host | --api-host | --auth-host | --version | --config-dir)
		[ "$#" -ge 2 ] && [ -n "$2" ] || fail "$1 needs a value"
		case "$1" in
		--domain) domain=$2 ;;
		--email) email=$2 ;;
		--console-host) console_host=$2 ;;
		--api-host) api_host=$2 ;;
		--auth-host) auth_host=$2 ;;
		--version) version=$2 ;;
		--config-dir) config_dir=$2 ;;
		esac
		shift 2
		;;
	*)
		usage >&2
		fail "unknown argument $1"
		;;
	esac
done

[ -n "$email" ] || fail '--email is required'
if [ -z "$domain" ] && { [ -z "$console_host" ] || [ -z "$api_host" ] || [ -z "$auth_host" ]; }; then
	fail '--domain is required unless --console-host, --api-host and --auth-host are all set'
fi
console_host=${console_host:-console.$domain}
api_host=${api_host:-api.$domain}
auth_host=${auth_host:-auth.$domain}

for host in "$console_host" "$api_host" "$auth_host"; do
	case "$host" in
	*[!A-Za-z0-9.-]* | .* | *. | '') fail "$host is not a hostname" ;;
	esac
done
[ "$console_host" != "$api_host" ] && [ "$console_host" != "$auth_host" ] && [ "$api_host" != "$auth_host" ] ||
	fail 'the console, API and Keycloak hostnames must differ'
case "$email" in
*[!A-Za-z0-9.@_+-]* | *@*@* | @* | *@) fail "$email is not an email address" ;;
*@*.*) ;;
*) fail "$email is not an email address" ;;
esac
# Image tags drop the Git tag's leading v.
version=${version#v}
case "$version" in
'' | *[!A-Za-z0-9._-]*) fail "$version is not an image tag" ;;
esac

root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
case "$config_dir" in
/*) ;;
*) config_dir="$(pwd)/$config_dir" ;;
esac
case "$config_dir" in
"$root" | "$root"/*) fail 'the private directory must be outside the checkout' ;;
esac
[ ! -e "$config_dir" ] || fail "$config_dir already exists. It holds an existing deployment's secrets, so this script never overwrites it."
[ ! -e "$root/.env" ] || fail "$root/.env already exists. Remove it only if no deployment uses it."

# Hex secrets need no URL or shell encoding.
random_hex() {
	od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'
}
hex=$(random_hex 16)
part() {
	printf '%s' "$hex" | cut -c"$1"
}
case $(part 17) in
[0-3]) variant=8 ;;
[4-7]) variant=9 ;;
[89ab]) variant=a ;;
*) variant=b ;;
esac
user_id="$(part 1-8)-$(part 9-12)-4$(part 14-16)-$variant$(part 18-20)-$(part 21-32)"

postgres_password=$(random_hex 32)
keycloak_postgres_password=$(random_hex 32)
login_token=$(random_hex 32)
console_token=$(random_hex 32)
client_secret=$(random_hex 32)
provider_key=$(random_hex 32)
first_password=$(random_hex 12)
issuer="https://$auth_host/realms/acclimate"

umask 077
mkdir -p -- "$config_dir"
chmod 700 "$config_dir"

printf '%s\n' "$postgres_password" >"$config_dir/postgres-password"
printf '%s\n' "$keycloak_postgres_password" >"$config_dir/keycloak-postgres-password"
: >"$config_dir/executor-token"

cat >"$config_dir/service.env" <<EOF
DATABASE_URL=postgresql://acclimate:$postgres_password@postgres:5432/acclimate
ACCLIMATE_OIDC_ISSUER=$issuer
ACCLIMATE_LOGIN_TOKEN=$login_token
ACCLIMATE_CONSOLE_TOKEN=$console_token
ACCLIMATE_OPERATORS=[{"issuer":"$issuer","subject":"$user_id"}]
ACCLIMATE_AUTH=[]
ACCLIMATE_PROVIDER_ENCRYPTION_KEY=$provider_key
EOF

cat >"$config_dir/console.env" <<EOF
CONSOLE_ORIGIN=https://$console_host
CONSOLE_SERVICE_URL=http://service:3000
CONSOLE_PUBLIC_API_URL=https://$api_host
CONSOLE_OIDC_ISSUER=$issuer
CONSOLE_OIDC_CLIENT_ID=acclimate-console
CONSOLE_OIDC_CLIENT_SECRET=$client_secret
CONSOLE_LOGIN_TOKEN=$login_token
CONSOLE_SERVICE_TOKEN=$console_token
CONSOLE_ALLOW_EDITS=true
EOF

# The ACCLIMATE_* values are read once, when Keycloak first imports the realm.
cat >"$config_dir/keycloak.env" <<EOF
KC_DB_PASSWORD=$keycloak_postgres_password
ACCLIMATE_CONSOLE_ORIGIN=https://$console_host
ACCLIMATE_OIDC_CLIENT_SECRET=$client_secret
ACCLIMATE_FIRST_USER_ID=$user_id
ACCLIMATE_FIRST_USER_EMAIL=$email
ACCLIMATE_FIRST_USER_PASSWORD=$first_password
EOF

umask 022
cat >"$root/.env" <<EOF
# Written by deploy/init.sh. Settings and paths only: the secrets are in ACCLIMATE_CONFIG_DIR.
COMPOSE_FILE=compose.yaml:compose.keycloak.yaml
CONSOLE_HOST=$console_host
API_HOST=$api_host
KEYCLOAK_HOST=$auth_host
ACME_EMAIL=$email
ACCLIMATE_CONFIG_DIR=$config_dir
ACCLIMATE_VERSION=$version
EOF

cat <<EOF
Wrote $config_dir and $root/.env.

Back up $config_dir off this server now. It holds every secret, including
the provider encryption key, which no other copy can replace.

Sign in to https://$console_host as $email with this temporary password.
Keycloak asks you to change it at your first sign-in:

  $first_password

Next, from $root:

  docker compose up -d --build --wait
EOF
