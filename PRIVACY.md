# Privacy

health-hub is a single-person, self-hosted application. There is no company
behind it, no shared service, and no other users.

## Who runs it

One person runs one copy of this software on a server they rent, for their own
data. The source is public so that the handling of that data can be checked.

## What it stores

* Meals: a short description, estimated calories and macronutrients, a
  timestamp.
* Body weight measurements.
* Daily metrics from connected devices: active energy, steps, resting heart
  rate, heart rate variability, sleep duration, readiness score, workout
  minutes, and the raw payload each source sent.
* OAuth tokens for the services the operator connects (currently Oura).

Everything lives in a Postgres database on the operator's own server.

## Where it goes

Nowhere. The data is not sold, shared, published, or sent to any third party.
It is read back only by the operator, through their own Claude account or their
own API token.

The software talks to exactly two kinds of outside service: the APIs it pulls
data from (Oura), and the operator's own Claude client, which connects to it.

## Oura data

If Oura is connected, the application reads daily activity, sleep and readiness
summaries, and sleep sessions, for the account that authorized it. It writes
nothing back to Oura. Access can be revoked at any time from the Oura account
page, which stops all further reads immediately.

## Retention and deletion

Data is kept until the operator deletes it. Because the operator is the only
user, deletion is a database command or deleting the server.

## Contact

Through the repository: https://github.com/wadadaaa/health-hub
