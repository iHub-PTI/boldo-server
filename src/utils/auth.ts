import { Response } from 'express'
import jwksClient from 'jwks-rsa'
import querystring from 'querystring'
import fetch from 'node-fetch'
import { verify, JwtHeader, SigningKeyCallback } from 'jsonwebtoken'

export const jwksKeycloakClient = jwksClient({
  jwksUri: `${process.env.KEYCLOAK_REALM_ADDRESS!}/protocol/openid-connect/certs`,
})

console.log('hello world')

//
//
// //////////////////////////////
//            Keycloak
// //////////////////////////////
//
//

interface getTokenProps {
  client_id: string
  grant_type: string
  code?: string
  refresh_token?: string
  redirect_uri?: string
}

export const getToken = async ({ client_id, grant_type, code, refresh_token, redirect_uri }: getTokenProps) => {
  const query = querystring.stringify({ client_id, grant_type, code, refresh_token, redirect_uri })

  try {
    const resp = await fetch(`${process.env.KEYCLOAK_REALM_ADDRESS!}/protocol/openid-connect/token`, {
      method: 'POST',
      body: query,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    })

    if (resp.ok) {
      return await resp.json()
    } else {
      console.log('Failed to get token')
      console.log(await resp.json())
      throw new Error(resp.statusText)
    }
  } catch (err) {
    console.log(err)
  }
}

export const verifyToken = (token: string) => {
  return new Promise<any>((resolve, reject) => {
    const getKey = (header: JwtHeader, callback: SigningKeyCallback) => {
      if (!header.kid) return reject('KID missing')

      jwksKeycloakClient.getSigningKey(header.kid, (err, key) => {
        if (err) return reject(err)
        const signingKey = key?.getPublicKey()
        callback(null, signingKey)
      })
    }

    const options = {
      audience: ['boldo-doctor', 'boldo-patient'],
      algorithms: ['RS256'] as ['RS256'],
      //   issuer: ['https://accounts.google.com', 'accounts.google.com'],
      // ignoreExpiration: true,
    }

    try {
      verify(token, getKey, options, (err, jwt: any) => {
        if (err) return reject(err)
        resolve(jwt)
      })
    } catch (err) {
      reject(err)
    }
  })
}
