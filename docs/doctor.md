---
section: '/doctor'
title: 'Boldo REST API'
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

---

### List Doctors

Search for Doctors and List Results.

```
GET /doctors
```

_Configuration is the same as iHub Resource. Addition:_

**Return Value:**

- nextAvailability: Date
