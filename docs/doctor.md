---
section: '/doctor'
title: '/doctor'
date: '2020-11-26T05:35:07.322Z'
priority: 80
ogImage:
  url: '/img/posts/boldo-cover.png'
---

# Doctor

Boldo Doctor implements the iHub Doctor model and adds information relevant for availability.

## Endpoints

The Doctor Resource provides the following endpoints:

- **Get /doctors**
- **Get /doctors/:id**
- **Get /doctors/:id/availability**

---

### List Doctors

Search for Doctors and List Results.

```
GET /doctors
```

_Configuration is the same as iHub Resource. Addition:_

**Return Value:**

- nextAvailability: Date

---

### Doctor Detail

Show details of a Doctor.

```
GET /doctors/:id
```

_Configuration is the same as iHub Resource._

---

### Doctor Availability

Show availability of a Doctor.

```
GET /doctors/:id/availability
```

**Access Level:** `Public`

**Parameters (as query params):**

- start: Date
- end: Date

**Return Value:** Doctor Details and List of availabilities.

```
{ ...doctor, availabilities: [Date, Date, ...], nextAvailability: Date }
```

> `start` and `end` parameters are the search window for availabilities. If start is in the past, it will be set to the current time, and the distance of both dates can be maximum of 31 days.
