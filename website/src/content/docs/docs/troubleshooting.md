---
title: Troubleshooting
description: What the error codes on the slotmirror sign-in pages mean and what to do.
---

When a sign-in or connect step fails, the page shows an error code and a reference. The page
never shows the text that Microsoft or Google sent, because that text can name the user. The
reference also appears in the Worker log, next to the code. Search the log for it.

Find your code below. A code without a section is shown with a link to this page; quote the code
and the reference when you ask for help.

## Consent errors

These codes mean that the sign-in stopped before slotmirror got access. Either the user
cancelled, or the organisation does not let users approve apps. Try again first. If it fails
again, an administrator of the Microsoft tenant has to approve the app. The error page contains a
request for the administrator that you can copy. After the approval, the administrator returns
to a short slotmirror page. That page does not sign anyone in. See also
[Check first: can I approve the app myself?](../entra-setup/#check-first-can-i-approve-the-app-myself).

### access_denied

The provider reports that access was not granted. The user may have chosen **Cancel**, or the
tenant blocks the approval (look for AADSTS65001, AADSTS90094 or AADSTS90095). With Google, the
user cancelled, or is not a test user of an app in **Testing** mode.

**What to do:** Try again and approve the access. If the tenant blocks the approval, send the
request from the error page to the administrator.

### consent_required

The provider needs an approval that the user has not given. In a work tenant this usually means
that the administrator has to approve first.

**What to do:** Send the request from the error page to the administrator, then try again.

### AADSTS65001

The user or an administrator has not approved the app for this tenant.

**What to do:** Try again and approve. If the approval is blocked, an administrator approves the
app for the tenant with the link in the request.

### AADSTS90094

The app needs approval from an administrator. The user cannot give it.

**What to do:** An administrator opens the link in the request and approves the app for the
organisation.

### AADSTS90095

The app needs approval from an administrator with a specific role, or the tenant's approval
workflow is on and has not finished.

**What to do:** Ask a Global Administrator, Privileged Role Administrator or Cloud Application
Administrator to approve the app with the link in the request.

## Account errors

### AADSTS50020

The account is not in the directory that the app signs in to. This happens with a guest or
personal account if the Entra app accepts one tenant only, or with an account from a tenant that
did not invite the user.

**What to do:** Sign in with an account of the tenant. Or, for the app registration, set the
supported account types to **Accounts in any organizational directory and personal Microsoft
accounts** (see [Microsoft Entra app](../entra-setup/)).

## Google "not verified" warning

This is a warning, not an error. Choose **Advanced**, then **Go to … (unsafe)**. See
[Google OAuth client](../google-setup/).
