"""Generate return requests for an outdoor gear shop, answered by a hidden policy.

The starting instructions name the five outcomes but none of the policy, so each rule below is
a root cause the learning loop has to discover from failed tasks. stages/1.csv to 4.csv bring
the rules in batches; test.csv covers every rule and is never imported. For each batch the
script picks the first seed whose file the service splits as needed (the service assigns a row
to held-out when the first byte of sha256("import:<sha256 of the file>:row:<line>") is below 128).

Run: python3 examples/gear-returns/generate.py
"""
import csv
import hashlib
import io
import random
from pathlib import Path

HERE = Path(__file__).resolve().parent

# The policy, in precedence order. Each entry: rule id, outcome, what it means.
POLICY = [
    ('rental', 'DENY', 'Rental gear goes back to the rental counter and is never refunded.'),
    ('used-safety', 'DENY', 'Life-safety gear (ropes, harnesses, helmets, carabiners) that has been used cannot be returned.'),
    ('defect', 'REPAIR', 'A manufacturing defect within two years of purchase is repaired, even on final-sale items.'),
    ('final-sale', 'STORE_CREDIT', 'Final-sale and clearance items get store credit, never a refund.'),
    ('gift', 'STORE_CREDIT', 'A gift returned without a receipt gets store credit.'),
    ('window', None, 'Summit Club members have 365 days. Everyone else has 60 days, then store credit until day 90, then nothing.'),
    ('worn-footwear', 'EXCHANGE', 'Footwear worn outdoors within the window can only be exchanged.'),
    ('opened-electronics', 'STORE_CREDIT', 'Opened electronics within the window get store credit.'),
    ('used-general', 'REFUND', 'Other gear used on a trip is still refunded within the window.'),
]

SAFETY = ['70 m dynamic rope', 'climbing harness', 'climbing helmet', 'set of locking carabiners', 'via ferrata lanyard']
FOOTWEAR = ['pair of approach shoes', 'pair of hiking boots', 'pair of trail runners', 'pair of mountaineering boots', 'pair of ski boots']
ELECTRONICS = ['GPS watch', 'rechargeable headlamp', 'satellite messenger', 'handheld GPS', 'avalanche transceiver']
GENERAL = ['down jacket', 'rain shell', '2-person tent', 'sleeping bag', 'trekking poles', '45 L backpack',
           'stove kit', 'fleece pullover', 'merino base layer', 'sleeping pad', 'water filter', 'softshell pants']
DEFECTS = ['the zipper pulled off the slider', 'a seam started leaking in light rain', 'the sole is peeling away from the upper',
           'the buckle snapped on the second use', 'the fabric delaminated at the shoulders', 'a pole section will not lock']
REASONS = ['it is not the right fit', 'I changed my mind', 'it is heavier than I expected', 'I found one I like better',
           'the colour looks different in person', 'my trip was cancelled']


def outcome(r):
    """The hidden policy. r is a dict of the request's facts."""
    if r['rental']:
        return 'DENY', 'rental'
    if r['kind'] == 'safety' and r['used']:
        return 'DENY', 'used-safety'
    if r['defect'] and r['days'] <= 730:
        return 'REPAIR', 'defect'
    if r['final_sale']:
        return 'STORE_CREDIT', 'final-sale'
    if r['gift'] and not r['receipt']:
        return 'STORE_CREDIT', 'gift'
    limit = 365 if r['member'] else 60
    if r['days'] > limit:
        if not r['member'] and r['days'] <= 90:
            return 'STORE_CREDIT', 'window'
        return 'DENY', 'window'
    if r['kind'] == 'footwear' and r['used']:
        return 'EXCHANGE', 'worn-footwear'
    if r['kind'] == 'electronics' and r['opened']:
        return 'STORE_CREDIT', 'opened-electronics'
    if r['kind'] == 'general' and r['used']:
        return 'REFUND', 'used-general'
    return 'REFUND', 'plain'


def base(rng, kind=None):
    kind = kind or rng.choice(['general', 'general', 'general', 'safety', 'footwear', 'electronics'])
    item = rng.choice({'general': GENERAL, 'safety': SAFETY, 'footwear': FOOTWEAR, 'electronics': ELECTRONICS}[kind])
    return dict(kind=kind, item=item, days=rng.randint(3, 50), member=rng.random() < 0.35, receipt=True, gift=False,
                used=False, opened=kind == 'electronics' and rng.random() < 0.3, defect=None, final_sale=False,
                rental=False, reason=rng.choice(REASONS))


def make(rng, rule):
    r = base(rng)
    if rule == 'rental':
        r.update(rental=True, item=rng.choice(GENERAL + SAFETY + FOOTWEAR), kind='general')
    elif rule == 'used-safety':
        r.update(kind='safety', item=rng.choice(SAFETY), used=True)
    elif rule == 'defect':
        r.update(defect=rng.choice(DEFECTS), days=rng.choice([rng.randint(70, 700), rng.randint(5, 50)]),
                 final_sale=rng.random() < 0.3)
    elif rule == 'final-sale':
        r.update(final_sale=True)
    elif rule == 'gift':
        r.update(gift=True, receipt=False)
    elif rule == 'window':
        r.update(days=rng.choice([rng.randint(61, 90), rng.randint(95, 200), rng.randint(370, 500)]))
        if r['days'] > 365:
            r['member'] = rng.random() < 0.5
        elif r['days'] > 90:
            r['member'] = False
    elif rule == 'worn-footwear':
        r.update(kind='footwear', item=rng.choice(FOOTWEAR), used=True, days=rng.randint(5, 55))
    elif rule == 'opened-electronics':
        r.update(kind='electronics', item=rng.choice(ELECTRONICS), opened=True, days=rng.randint(3, 55))
    elif rule == 'used-general':
        r.update(kind='general', item=rng.choice(GENERAL), used=True, days=rng.randint(5, 55))
    elif rule == 'plain':
        r.update(days=rng.randint(2, 55), used=False, opened=False)
    # Members inside a long window show the 365-day rule is not the 60-day one.
    if rule in ('worn-footwear', 'opened-electronics', 'used-general', 'plain') and rng.random() < 0.3:
        r.update(member=True, days=rng.randint(70, 340))
    return r


def a(item):
    return ('an ' if item[0] in 'aeiou' else 'a ') + item


def describe(rng, r):
    when = (f'{r["days"]} days ago' if r['days'] < 60 or rng.random() < 0.5
            else f'about {round(r["days"] / 30)} months ago ({r["days"]} days)')
    parts = []
    if r['rental']:
        parts.append(rng.choice([f'I rented {a(r["item"])} from your shop {when} for a weekend trip.',
                                 f'The {r["item"]} I hired from you {when} is still with me.']))
    elif r['gift']:
        parts.append(rng.choice([f'Someone gave me {a(r["item"])} as a present. They bought it {when}.',
                                 f'I received {a(r["item"])} as a gift; it was bought {when}.']))
    else:
        parts.append(rng.choice([f'I bought {a(r["item"])} {when}.', f'Purchased {a(r["item"])} from you {when}.',
                                 f'{when.capitalize()} I picked up {a(r["item"])} in store.']))
    if r['final_sale']:
        parts.append(rng.choice(['It was on the clearance rack, marked final sale.', 'It was a final-sale item.']))
    if r['defect']:
        parts.append(f'Problem: {r["defect"]}.')
    elif r['kind'] == 'safety':
        parts.append('I used it on two climbs.' if r['used'] else 'It is unused, still with the tags on.')
    elif r['kind'] == 'footwear':
        parts.append(rng.choice(['I wore them on a couple of trail days.', 'I took them out on one muddy hike.'])
                     if r['used'] else 'I only tried them on indoors.')
    elif r['kind'] == 'electronics':
        parts.append('I opened the box and set it up.' if r['opened'] else 'The box is still sealed.')
    elif r['kind'] == 'general' and r['used']:
        parts.append(rng.choice(['I used it on one trip.', 'I took it on a weekend in the hills.', 'It has been used a few times.']))
    if not r['defect'] and not r['rental']:
        parts.append(f'I want to return it because {r["reason"]}.')
    parts.append('I am a Summit Club member.' if r['member'] else rng.choice(['I am not a member.', 'No membership.']))
    if not r['rental']:
        parts.append('I have the receipt.' if r['receipt'] else 'There is no receipt.')
    return ' '.join(parts)


# New evidence arrives in batches, as corrections would from a live agent. Each batch brings
# tasks for rules the earlier batches never showed. The first batch needs 20 tasks on each side
# for learning to start, and each later one adds well over the 5 evolve tasks that wake the loop.
STAGES = [
    ['plain', 'rental', 'used-safety', 'window'],
    ['final-sale', 'gift'],
    ['worn-footwear', 'opened-electronics'],
    ['used-general', 'defect'],
]
PER_RULE = {0: 12, 1: 9, 2: 9, 3: 9}
TEST_PER_RULE = 6


def rows_for(rng, rules, count):
    rows = []
    for rule in rules:
        made = 0
        while made < count:
            r = make(rng, rule)
            answer, fired = outcome(r)
            if fired == rule:
                rows.append((describe(rng, r), answer, fired))
                made += 1
    rng.shuffle(rows)
    return rows


def render(rows):
    out = io.StringIO()
    writer = csv.writer(out, lineterminator='\n')
    writer.writerow(['input', 'expected'])
    for text, answer, _ in rows:
        writer.writerow([text, answer])
    return out.getvalue().encode()


def split(data, count):
    digest = hashlib.sha256(data).hexdigest()
    # The header is line 1, so data row i is on line i + 2.
    return ['held-out' if hashlib.sha256(f'import:{digest}:row:{i + 2}'.encode()).digest()[0] < 128 else 'evolve'
            for i in range(count)]


def balanced(stage, rows, sides):
    evolve = [fired for (_, _, fired), side in zip(rows, sides) if side == 'evolve']
    if stage == 0 and min(sides.count('evolve'), sides.count('held-out')) < 22:
        return False
    # Every new rule shows up at least three times among the tasks the loop learns from.
    return all(evolve.count(rule) >= 3 for rule in STAGES[stage])


def main():
    (HERE / 'stages').mkdir(exist_ok=True)
    seen = set()
    for stage, rules in enumerate(STAGES):
        for seed in range(1, 10_000):
            rows = rows_for(random.Random(1000 * stage + seed), rules, PER_RULE[stage])
            if any(text in seen for text, _, _ in rows):
                continue
            data = render(rows)
            sides = split(data, len(rows))
            if balanced(stage, rows, sides):
                break
        else:
            raise SystemExit(f'no seed balanced stage {stage + 1}')
        seen.update(text for text, _, _ in rows)
        (HERE / 'stages' / f'{stage + 1}.csv').write_bytes(data)
        print(f'stage {stage + 1}: {len(rows)} rows, {sides.count("evolve")} evolve, '
              f'{sides.count("held-out")} held out; rules {", ".join(rules)}')
    # The fixed test set covers every rule and is never imported, so the loop never sees it.
    rng = random.Random(424242)
    test = [row for row in rows_for(rng, [rule for stage in STAGES for rule in stage], TEST_PER_RULE)
            if row[0] not in seen]
    (HERE / 'test.csv').write_bytes(render(test))
    print(f'test: {len(test)} rows')


if __name__ == '__main__':
    main()
