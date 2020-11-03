---
section: '/profile/*'
title: 'Boldo REST API'
date: '2020-10-26T05:35:07.322Z'
priority: 90
ogImage:
  url: '/img/posts/boldo-cover.png'
---

# Profile Scope

Some endpoints are prefixed with /profile. These endpoints give special access to resources to which the currently authenticated user has special permissions.

## Endpoints

The Profile Scope provides the following endpoints for the **Patient Resource**:

- **GET /profile/patient**
- **POST /profile/patient**

And the following endpoints for the **Doctor Resource**:

- **Get /profile/doctor**
- **POST /profile/doctor**

### Get Patient

Read the currently authenticated Patient

```
GET /profile/patient
```

**Access Level:** `Authorized`

**Parameters:** none

**Return Value:** Patient

---

### Update Patient

Update the currently authenticated Patient

```
POST /profile/patient
```

**Access Level:** `Authorized`

**Parameters:** Patient

**Return Value:** Patient (updated)

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
