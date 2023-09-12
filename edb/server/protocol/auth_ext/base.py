#
# This source file is part of the EdgeDB open source project.
#
# Copyright 2016-present MagicStack Inc. and the EdgeDB authors.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
#

import uuid
import urllib.parse
import json

from jwcrypto import jwt, jwk
from datetime import datetime

from . import data, errors


class BaseProvider:
    def __init__(
        self,
        name: str,
        issuer_url: str,
        client_id: str,
        client_secret: str,
        *,
        http_factory,
    ):
        self.name = name
        self.issuer_url = issuer_url
        self.client_id = client_id
        self.client_secret = client_secret
        self.http_factory = http_factory

    async def get_code_url(self, state: str, redirect_uri: str) -> str:
        raise NotImplementedError

    async def exchange_code(self, code: str) -> data.OAuthAccessTokenResponse:
        raise NotImplementedError

    async def fetch_user_info(
        self, token_response: data.OAuthAccessTokenResponse
    ) -> data.UserInfo:
        raise NotImplementedError

    def _maybe_isoformat_to_timestamp(self, value: str | None) -> float | None:
        return datetime.fromisoformat(value).timestamp() if value else None


class OpenIDProvider(BaseProvider):
    def __init__(self, name: str, issuer_url: str, *args, **kwargs):
        super().__init__(name, issuer_url, *args, **kwargs)

    async def get_code_url(self, state: str, redirect_uri: str) -> str:
        oidc_config = await self._get_oidc_config()
        params = {
            "client_id": self.client_id,
            "scope": "openid profile email",
            "state": state,
            "redirect_uri": redirect_uri,
            "nonce": str(uuid.uuid4()),
            "response_type": "code",
        }
        encoded = urllib.parse.urlencode(params)
        return f"{oidc_config.authorization_endpoint}?{encoded}"

    async def exchange_code(
        self, code: str
    ) -> data.OpenIDConnectAccessTokenResponse:
        oidc_config = await self._get_oidc_config()

        token_endpoint = urllib.parse.urlparse(oidc_config.token_endpoint)
        async with self.http_factory(
            base_url=f"{token_endpoint.scheme}://{token_endpoint.netloc}"
        ) as client:
            resp = await client.post(
                token_endpoint.path,
                json={
                    "grant_type": "authorization_code",
                    "code": code,
                    "client_id": self.client_id,
                    "client_secret": self.client_secret,
                },
            )
            json = resp.json()

            return data.OpenIDConnectAccessTokenResponse(**json)

    async def fetch_user_info(
        self, token_response: data.OAuthAccessTokenResponse
    ) -> data.UserInfo:
        if not isinstance(
            token_response, data.OpenIDConnectAccessTokenResponse
        ):
            raise TypeError(
                "token_response must be of type "
                "OpenIDConnectAccessTokenResponse"
            )
        id_token = token_response.id_token

        # Retrieve JWK Set
        oidc_config = await self._get_oidc_config()
        jwks_uri = urllib.parse.urlparse(oidc_config.jwks_uri)
        async with self.http_factory(
            base_url=f"{jwks_uri.scheme}://{jwks_uri.netloc}"
        ) as client:
            r = await client.get(jwks_uri.path)

        # Load the token as a JWT object and verify it directly
        try:
            jwk_set = jwk.JWKSet.from_json(r.text)
            id_token_verified = jwt.JWT(key=jwk_set, jwt=id_token)
            payload = json.loads(id_token_verified.claims)
        except Exception as e:
            raise errors.MisconfiguredProvider(
                "Failed to parse ID token with provider keyset"
            ) from e
        if payload.get("iss") != self.issuer_url:
            raise errors.InvalidData("Invalid value for iss in id_token")
        if payload.get("aud") != self.client_id:
            raise errors.InvalidData("Invalid value for aud in id_token")

        return data.UserInfo(
            sub=str(payload["sub"]),
            name=payload.get("name"),
            email=payload.get("email"),
            picture=payload.get("picture"),
        )

    async def _get_oidc_config(self):
        client = self.http_factory(base_url=self.issuer_url)
        response = await client.get('/.well-known/openid-configuration')
        config = response.json()
        return data.OpenIDConfig(**config)