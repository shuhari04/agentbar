#!/usr/bin/env python3
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright

ORIGIN = os.environ.get("BAR_TEST_ORIGIN", "http://127.0.0.1:19110")
OUT = Path(os.environ.get("BAR_TEST_OUTPUT", "/tmp/agentbar-agent-bar-ui"))
OUT.mkdir(parents=True, exist_ok=True)

USER = {"id": "user-1", "email": "player@agentbar.test", "name": "Lei", "image": ""}
PLAYERS = [
    {"id": "p1", "ownerName": "Lei", "agentName": "Mori", "seatIndex": 0, "avatarLabel": "MO", "avatarUrl": "", "assistMode": "assist", "status": "online", "joinedAt": "2026-07-10T00:00:00Z", "lastSeenAt": "2099-01-01T00:00:00Z"},
    {"id": "p2", "ownerName": "Nova", "agentName": "Pixel", "seatIndex": 4, "avatarLabel": "PI", "avatarUrl": "", "assistMode": "autopilot", "status": "online", "joinedAt": "2026-07-10T00:00:00Z", "lastSeenAt": "2099-01-01T00:00:00Z"},
    {"id": "p3", "ownerName": "Rin", "agentName": "Echo", "seatIndex": 8, "avatarLabel": "EC", "avatarUrl": "", "assistMode": "assist", "status": "online", "joinedAt": "2026-07-10T00:00:00Z", "lastSeenAt": "2099-01-01T00:00:00Z"},
    {"id": "p4", "ownerName": "Yan", "agentName": "Orbit", "seatIndex": 12, "avatarLabel": "OR", "avatarUrl": "", "assistMode": "assist", "status": "online", "joinedAt": "2026-07-10T00:00:00Z", "lastSeenAt": "2099-01-01T00:00:00Z"},
]

def room_summary(room_id, name, game_type):
    return {"id": room_id, "name": name, "hostName": "Lei", "gameType": game_type, "visibility": "public", "playerCount": 4, "onlineCount": 4, "maxPlayers": 16, "gamePhase": "playing", "ownerUserId": "user-1"}

def deck_state():
    decision = {"id": "decision-deck", "gameId": "game-deck", "playerId": "p1", "type": "liar_deck_turn", "status": "pending", "assistMode": "assist", "deadlineAt": "2099-01-01T00:00:00Z", "recommendedOptionId": "play-card-1", "agentSuggestion": {"optionId": "play-card-1", "reason": "先用一张 A 探路。", "confidence": .81}}
    return {
        "room": room_summary("room-deck", "午夜牌桌", "liar_deck"),
        "players": PLAYERS,
        "messages": [{"id": "m1", "playerId": "p2", "ownerName": "Nova", "agentName": "Pixel", "seatIndex": 4, "kind": "turn", "text": "我只出一张。", "createdAt": "2026-07-10T00:00:00Z"}],
        "game": {"id": "game-deck", "type": "liar_deck", "phase": "playing", "round": 2, "decision": decision, "targetRank": "Ace", "roulette": {"chamberCount": 6, "remainingChambers": 4, "pulls": 2, "lastOutcome": "safe"}, "turnPlayerId": "p1", "turnAgentName": "Mori", "playerOrder": ["p1","p2","p3","p4"], "players": [{"id": p["id"], "agentName": p["agentName"], "status": "eliminated" if p["id"] == "p4" else "alive", "cardsRemaining": 5, "lastClaim": {"count": 2, "rank": "Ace"} if p["id"] == "p2" else None} for p in PLAYERS], "lastPlay": {"id": "play-last", "playerId": "p2", "agentName": "Pixel", "count": 1}, "plays": [], "lastReveal": None, "eliminations": [], "result": None}
    }

def deck_private():
    state = deck_state()
    options = [
        {"id": "play-card-1", "label": "出 A", "hint": "声明为 A", "action": {"gameId": "game-deck", "action": "play_cards", "cardIds": ["card-1"], "text": "我出一张 A。"}},
        {"id": "play-card-2", "label": "出 K", "hint": "声明为 A", "action": {"gameId": "game-deck", "action": "play_cards", "cardIds": ["card-2"], "text": "我出一张 A。"}},
        {"id": "challenge", "label": "质疑上一手", "hint": "不相信上一位暗扣的牌", "action": {"gameId": "game-deck", "action": "challenge", "text": "我不信，开。"}},
    ]
    decision = {**state["game"]["decision"], "options": options}
    return {"player": PLAYERS[0], "game": {**state["game"], "isMyTurn": True}, "private": {"hand": [{"id":"card-1","rank":"Ace"},{"id":"card-2","rank":"King"},{"id":"card-3","rank":"Joker"},{"id":"card-4","rank":"Queen"},{"id":"card-5","rank":"Ace"}]}, "decision": decision, "allowedActions": ["play_cards","challenge"]}

def dice_state():
    decision = {"id": "decision-dice", "gameId": "game-dice", "playerId": "p1", "type": "liar_dice_turn", "status": "pending", "assistMode": "assist", "deadlineAt": "2099-01-01T00:00:00Z", "recommendedOptionId": "bid-3-4", "agentSuggestion": {"optionId": "bid-3-4", "reason": "手里有两个 4，可以稳一点。", "confidence": .74}}
    return {
        "room": room_summary("room-dice", "红骰酒局", "liar_dice"),
        "players": PLAYERS,
        "messages": [],
        "game": {"id": "game-dice", "type": "liar_dice", "phase": "bidding", "round": 1, "decision": decision, "turnPlayerId": "p1", "turnAgentName": "Mori", "playerOrder": ["p1","p2","p3","p4"], "diceCount": 5, "lastBid": {"playerId":"p2","agentName":"Pixel","quantity":2,"face":4}, "bids": [], "diceRevealed": False, "dice": [], "stats": None, "result": None}
    }

def dice_private():
    state = dice_state()
    options = [
        {"id":"bid-3-4","label":"叫 3 个 4","hint":"比上一手更高","action":{"gameId":"game-dice","action":"bid","quantity":3,"face":4,"text":"我叫 3 个 4。"}},
        {"id":"bid-3-5","label":"叫 3 个 5","hint":"比上一手更高","action":{"gameId":"game-dice","action":"bid","quantity":3,"face":5,"text":"我叫 3 个 5。"}},
        {"id":"challenge","label":"质疑开骰","hint":"不相信上一手叫点","action":{"gameId":"game-dice","action":"challenge","text":"我不信，开骰。"}},
    ]
    return {"player": PLAYERS[0], "game": {**state["game"], "isMyTurn": True}, "private": {"dice": [4,4,1,2,6]}, "decision": {**state["game"]["decision"], "options": options}, "allowedActions": []}

def session(room_id, game_type, name):
    return {"room": {**room_summary(room_id, name, game_type), "ownerUserId": "user-1"}, "player": PLAYERS[0], "agentToken": "test-token", "agentPrompt": f"GET /api/bar/rooms/{room_id}/agent/inbox\nAuthorization: Bearer test-token"}

def host_state():
    state = deck_state()
    return {"room": state["room"], "players": PLAYERS, "game": state["game"], "maxPlayers": 16, "private": {"game": {"type": "liar_deck", "handsByPlayerId": {p["id"]: [{"rank": "Ace"}] for p in PLAYERS}}}}

def install_routes(page):
    committed_actions = []
    def handler(route):
        path = route.request.url.split(ORIGIN)[-1]
        method = route.request.method
        payload = {"ok": True}
        if path == "/api/bar/session":
            payload = {"ok": True, "user": USER}
        elif path == "/api/bar/rooms":
            payload = {"ok": True, "rooms": [room_summary("room-deck","午夜牌桌","liar_deck"), room_summary("room-dice","红骰酒局","liar_dice")]}
        elif "/events" in path:
            route.fulfill(status=200, content_type="text/event-stream", body="retry: 60000\n\n")
            return
        elif "room-deck/player/private" in path:
            payload = {"ok": True, **deck_private()}
        elif "room-dice/player/private" in path:
            payload = {"ok": True, **dice_private()}
        elif "room-deck/state" in path:
            payload = {"ok": True, "state": deck_state()}
        elif "room-dice/state" in path:
            payload = {"ok": True, "state": dice_state()}
        elif "host/state" in path:
            payload = {"ok": True, "state": host_state()}
        elif method == "POST" and path == "/api/bar/rooms/join":
            payload = {"ok": True, **session("room-deck", "liar_deck", "午夜牌桌"), "state": deck_state()}
        elif method == "POST" and "/player/assist-mode" in path:
            payload = {"ok": True, "player": {**PLAYERS[0], "assistMode": "autopilot"}, "state": deck_state() if "deck" in path else dice_state()}
        elif method == "POST" and "/decision/commit" in path:
            committed_actions.append(route.request.post_data_json)
            payload = {"ok": True, "state": deck_state() if "deck" in path else dice_state()}
        elif method == "POST":
            payload = {"ok": True, "state": deck_state() if "deck" in path else dice_state()}
        route.fulfill(status=200, content_type="application/json", body=json.dumps(payload))
    page.route("**/api/bar/**", handler)
    return committed_actions

def set_room_session(page, room_id, game_type, name):
    value = session(room_id, game_type, name)
    page.evaluate("([key,value]) => localStorage.setItem(key, JSON.stringify(value))", [f"agentbarRoomSession:{room_id}", value])

def assert_no_overflow(page):
    overflow = page.evaluate("() => document.documentElement.scrollWidth - document.documentElement.clientWidth")
    assert overflow <= 1, f"horizontal overflow: {overflow}px"

def run():
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", args=["--use-angle=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"])
        context = browser.new_context(viewport={"width": 1440, "height": 900}, device_scale_factor=1)
        page = context.new_page()
        page.on("pageerror", lambda error: errors.append(str(error)))
        committed_actions = install_routes(page)

        page.goto(f"{ORIGIN}/", wait_until="networkidle")
        page.locator("[data-bar-room-list] .bar-room-tile").first.wait_for(state="visible")
        assert page.locator("[data-bar-room-list] .bar-room-tile").count() == 2
        page.locator("[data-bar-account-menu-toggle]").click()
        assert page.locator("[data-bar-avatar-edit]").is_visible()
        page.screenshot(path=str(OUT / "lobby-desktop.png"), full_page=True)
        assert_no_overflow(page)

        page.locator("[data-join-room-id]").first.click()
        page.locator("[data-bar-join-room-form] input[name='agentName']").fill("Mori")
        page.locator("[data-bar-join-room-form]").evaluate("form => form.requestSubmit()")
        page.locator("[data-bar-join-prompt]").wait_for(state="visible")
        assert "Authorization: Bearer" in page.locator("[data-bar-join-prompt-text]").input_value()
        page.screenshot(path=str(OUT / "join-prompt.png"), full_page=True)
        page.locator("[data-bar-join-enter-room]").click()
        page.locator("body.has-three-bar").wait_for(state="attached", timeout=10000)
        page.locator("[data-bar-host-toggle]").click()
        page.locator("aside[data-bar-host-drawer]").wait_for(state="visible")
        page.wait_for_function("() => document.querySelector('[data-bar-host-start-title]')?.textContent === '骗子酒馆'")
        page.locator("[data-bar-host-game-type]").select_option("liar_dice")
        assert page.locator("[data-bar-host-dice-field]").is_visible()
        assert page.locator("[data-bar-host-start-title]").inner_text() == "吹牛骰子"
        page.wait_for_timeout(600)
        page.screenshot(path=str(OUT / "host-controls.png"), full_page=True)
        page.locator("[data-bar-host-close]").click()

        set_room_session(page, "room-deck", "liar_deck", "午夜牌桌")
        page.goto(f"{ORIGIN}/?room=room-deck", wait_until="domcontentloaded")
        page.locator("body.has-three-bar").wait_for(state="attached", timeout=10000)
        page.locator("[data-bar-card-hand] .bar-card").first.wait_for(state="visible")
        page.locator("[data-bar-deck-status]").wait_for(state="visible")
        assert page.locator("[data-bar-deck-target]").inner_text() == "A"
        assert "4/6" in page.locator("[data-bar-deck-roulette]").inner_text()
        page.locator("[data-bar-card-hand] .bar-card").first.hover()
        page.locator("[data-bar-card-hand] .bar-card").first.click()
        assert "is-selected" in page.locator("[data-bar-card-hand] .bar-card").first.get_attribute("class")
        assert page.locator("[data-bar-challenge]").is_enabled()
        page.locator("[data-bar-challenge]").click()
        page.wait_for_timeout(120)
        assert committed_actions[-1]["action"]["action"] == "challenge"
        page.mouse.move(1080, 350, steps=8)
        page.wait_for_timeout(500)
        page.screenshot(path=str(OUT / "deck-seat-pov.png"))
        assert_no_overflow(page)

        set_room_session(page, "room-dice", "liar_dice", "红骰酒局")
        page.goto(f"{ORIGIN}/?room=room-dice", wait_until="domcontentloaded")
        page.locator("body.has-three-bar").wait_for(state="attached", timeout=10000)
        page.locator("[data-bar-submit-bid]").wait_for(state="visible")
        assert page.locator("[data-bar-dice-values] b").count() == 5
        page.mouse.move(720, 610, steps=8)
        page.wait_for_timeout(500)
        page.screenshot(path=str(OUT / "dice-seat-pov.png"))
        assert_no_overflow(page)

        mobile = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=1, reduced_motion="reduce")
        mobile_page = mobile.new_page()
        mobile_page.on("pageerror", lambda error: errors.append(f"mobile: {error}"))
        install_routes(mobile_page)
        mobile_page.goto(f"{ORIGIN}/", wait_until="networkidle")
        set_room_session(mobile_page, "room-deck", "liar_deck", "午夜牌桌")
        mobile_page.goto(f"{ORIGIN}/?room=room-deck", wait_until="domcontentloaded")
        try:
            mobile_page.locator("[data-bar-card-hand] .bar-card").first.wait_for(state="visible", timeout=25000)
        except Exception:
            mobile_page.screenshot(path=str(OUT / "mobile-failure.png"))
            print("mobile diagnostics", mobile_page.url, mobile_page.locator("body").get_attribute("data-bar-view"), mobile_page.locator("[data-bar-status]").inner_text())
            raise
        mobile_page.screenshot(path=str(OUT / "deck-mobile.png"))
        assert_no_overflow(mobile_page)
        mobile.close()
        context.close()
        browser.close()

    assert not errors, "page errors: " + " | ".join(errors)
    print(f"Agent Bar UI smoke passed. Screenshots: {OUT}")

if __name__ == "__main__":
    run()
