---
# section: '/profile/*'
title: '/profile/doctor'
date: '2020-11-26T05:35:07.322Z'
priority: 90
ogImage:
  url: '/img/posts/boldo-cover.png'
---

# Doctor Profile Scope

Endpoints that begin with /profile/doctor give access to resources based on the currently authenticated user and its role doctor.

## Endpoints

The Profile Scope provides the following endpoints:

- **Get /profile/doctor**
- **POST /profile/doctor**

---

### Get Doctor

Read the currently authenticated Doctor

```
GET /profile/doctor
```

**Access Level:** `Authorized`

**Parameters:** none

**Return Value:** Doctor

---

### Update Doctor

Update the currently authenticated Doctor

```
POST /profile/doctor
```

**Access Level:** `Authorized`

**Parameters:** Doctor

**Return Value:** Doctor (updated)
