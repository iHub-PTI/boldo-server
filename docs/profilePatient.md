---
section: '/profile/patient*'
title: '/profile/patient'
date: '2020-11-26T05:35:07.322Z'
priority: 95
ogImage:
  url: '/img/posts/boldo-cover.png'
---

# Profile Scope

Endpoints that begin with /profile/patient give access to resources based on the currently authenticated user and its role patient.

## Endpoints

The Profile Scope provides the following endpoints:

- **GET /profile/patient**
- **POST /profile/patient**
- **POST /profile/patient/appointments**

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

## **Return Value:** Patient (updated)

### Create Appointment

Create an appointment for the currently authenticated Patient

```
POST /profile/patient/appointments
```

**Access Level:** `Authorized`

**Parameters:**

- start: Date
- doctorId: string

**Return Value:** Appointment (including id)
