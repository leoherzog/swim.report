// src/alertsCheckable.js — whether a beach row's zone columns let the crons look
// its alerts up at all. Pure and dependency-free, so both the cron side
// (buildEstimateInputs, src/flagInputs.js) and the request path's renderer read
// the same answer and their two caveats can never disagree on one page.

// A land zone or an ECCC region. marine_zone alone is not enough: it matches
// marine warnings but none of the land products the caveat is about, so a beach
// whose only zone is marine still reads "alerts are not checked here yet".
export function alertsCheckable(beach) {
  return (beach && (beach.nws_zone || beach.eccc_zone)) ? true : false;
}
