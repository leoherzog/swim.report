// test/officialSources.test.js
import { describe, it, expect } from "vitest";
import { parseSouthHavenHtml, southHaven } from "../src/officialSources/southHaven.js";
import { findScraper } from "../src/officialSources/index.js";

describe("parseSouthHavenHtml", function() {
  it("parses Red.png as red", function() {
    const html = "<img src=\"images/BeachFlags/Red.png?t=1\" alt=\"Red\">";
    expect(parseSouthHavenHtml(html)).toBe("red");
  });

  it("parses Green.png as green", function() {
    const html = "<img src=\"images/BeachFlags/Green.png?t=1\" alt=\"Green\">";
    expect(parseSouthHavenHtml(html)).toBe("green");
  });

  it("parses Yellow.png as yellow", function() {
    const html = "<img src=\"images/BeachFlags/Yellow.png?t=1\" alt=\"Yellow\">";
    expect(parseSouthHavenHtml(html)).toBe("yellow");
  });

  it("parses Grey2.png as null (unmonitored)", function() {
    const html = "<img src=\"images/BeachFlags/Grey2.png?t=1\" alt=\"Grey\">";
    expect(parseSouthHavenHtml(html)).toBe(null);
  });

  it("returns null for empty or null input", function() {
    expect(parseSouthHavenHtml("")).toBe(null);
    expect(parseSouthHavenHtml(null)).toBe(null);
  });
});

describe("southHaven.matches", function() {
  it("matches a beach named South Haven South Beach", function() {
    const beach = { id: "osm-node-1", name: "South Haven South Beach", lat: 42.4, lon: -86.28, nws_zone: null, nws_grid_url: null, osm_id: "node/1" };
    expect(southHaven.matches(beach)).toBe(true);
  });

  it("matches a beach inside the South Haven bounding box with an unrelated name", function() {
    const beach = { id: "osm-node-2", name: "Packard Park Beach", lat: 42.39, lon: -86.28, nws_zone: null, nws_grid_url: null, osm_id: "node/2" };
    expect(southHaven.matches(beach)).toBe(true);
  });

  it("does not match Holland State Park coordinates", function() {
    const beach = { id: "osm-node-3", name: "Holland State Park", lat: 42.7739, lon: -86.2109, nws_zone: null, nws_grid_url: null, osm_id: "node/3" };
    expect(southHaven.matches(beach)).toBe(false);
  });
});

describe("findScraper", function() {
  it("returns southHaven for a matching BeachRow", function() {
    const beach = { id: "osm-node-1", name: "South Haven North Beach", lat: 42.41, lon: -86.29, nws_zone: null, nws_grid_url: null, osm_id: "node/1" };
    expect(findScraper(beach)).toBe(southHaven);
  });

  it("returns null for a non-matching BeachRow", function() {
    const beach = { id: "osm-node-3", name: "Holland State Park", lat: 42.7739, lon: -86.2109, nws_zone: null, nws_grid_url: null, osm_id: "node/3" };
    expect(findScraper(beach)).toBe(null);
  });
});
