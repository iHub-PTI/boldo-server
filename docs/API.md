---
title: 'Boldo API Docs'
date: '2020-10-26T05:35:07.322Z'
priority: 90
ogImage:
  url: '/img/posts/boldo-cover.png'
---

# API Endpoints

The Boldo API allows you to access all queries related to Doctors, Patients and Appointments required for the app and web app to work.

## Working with the API

### Request Payloads

**For POST Requests:** Add paramters as JSON in the request body and set a `'Content-Type: application/json'` header.

**For GET Requests:** Add parameters as Query String parameters.

### Errors

For simplicity, expect the following error codes:

- 200 (OK)
- 400 (Client Error). There should be a `{messsages: string[]}` that includes a description of what went wrong.
- 500 (Server Error). Something went wrong. It was probably you - but maybe it was us. 🤓 If you can't figure it out, open an issue!
