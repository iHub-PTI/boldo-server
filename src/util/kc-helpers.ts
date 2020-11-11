import { Request } from 'express'
import uuid from 'keycloak-connect/uuid'

import { keycloak } from '../server'

export const createLoginUrl = (req: Request, url: string) => {
  // CONSTRUCT REDIRECT URI
  const host = req.hostname
  const headerHost = req.headers?.host?.split(':') || []
  const port = headerHost[1] || ''
  const protocol = req.protocol
  const hasQuery = ~url.indexOf('?')

  const redirectUrl =
    protocol + '://' + host + (port === '' ? '' : ':' + port) + url + (hasQuery ? '&' : '?') + 'auth_callback=1'

  // SET REDIRECT URI TO SESSION
  // THIS IS KEY, AS KC USES THE SESSIONS's ONE
  if (req.session) {
    req.session.auth_redirect_uri = redirectUrl
  }

  return keycloak.loginUrl(uuid(), redirectUrl)
}
