#!/usr/bin/env python3
"""THE LAB - analyst consensus builder.

Averages positional ranks from Alex's preferred analysts into
data/consensus_ranks.json, which compute.py merges into players.json (`cr`).
Sources (pasted 2026-08-13): Joel Smyth, FantasyPros ECR, Flock Fantasy,
The Fantasy Footballers. FantasyPros RB list was a duplicate of QB (paste
error) so FP contributes QB/WR/TE only.

Edit the lists below and rerun to update: python build_consensus.py
"""
import json
from pathlib import Path

JOEL_QB = ["Josh Allen", "Lamar Jackson", "Drake Maye", "Jayden Daniels", "Joe Burrow",
"Jalen Hurts", "Caleb Williams", "Justin Herbert", "Trevor Lawrence", "Jaxson Dart",
"Brock Purdy", "Dak Prescott", "Bo Nix", "Patrick Mahomes II", "Matthew Stafford",
"Kyler Murray", "Jared Goff", "Malik Willis", "Tyler Shough", "Baker Mayfield",
"Jordan Love", "Cam Ward", "Sam Darnold", "Bryce Young", "Daniel Jones",
"Fernando Mendoza", "C.J. Stroud", "Jacoby Brissett", "Michael Penix Jr.",
"Aaron Rodgers", "Geno Smith", "Shedeur Sanders"]

JOEL_RB = ["Jahmyr Gibbs", "Bijan Robinson", "Christian McCaffrey", "Jonathan Taylor",
"James Cook III", "Omarion Hampton", "Ashton Jeanty", "Kenneth Walker III", "Chase Brown",
"Saquon Barkley", "Derrick Henry", "De'Von Achane", "Jeremiyah Love", "Josh Jacobs",
"Kyren Williams", "Breece Hall", "Javonte Williams", "Cam Skattebo", "Bucky Irving",
"David Montgomery", "Travis Etienne Jr.", "Bhayshul Tuten", "D'Andre Swift",
"Quinshon Judkins", "TreVeyon Henderson", "Jadarian Price", "Jonathon Brooks",
"Rhamondre Stevenson", "Jaylen Warren", "Rico Dowdle", "RJ Harvey", "Tony Pollard",
"Chuba Hubbard", "Blake Corum", "Kyle Monangai", "Jordan Mason", "J.K. Dobbins",
"Jacory Croskey-Merritt", "Rachaad White", "Kenny Gainwell", "Zach Charbonnet",
"Chris Rodriguez Jr.", "Aaron Jones Sr.", "Keaton Mitchell", "Tank Bigsby",
"Isiah Pacheco", "Tyler Allgeier", "Ray Davis", "Tyrone Tracy Jr.", "Alvin Kamara",
"Woody Marks", "Jonah Coleman", "Brian Robinson Jr.", "Tyjae Spears", "Isaiah Davis",
"Emmett Johnson", "Mike Washington Jr.", "Jaydon Blue", "Ollie Gordon II",
"Dylan Sampson", "Nicholas Singleton", "James Conner"]

JOEL_WR = ["Ja'Marr Chase", "Puka Nacua", "Amon-Ra St. Brown", "Jaxon Smith-Njigba",
"CeeDee Lamb", "Justin Jefferson", "Drake London", "A.J. Brown", "George Pickens",
"Nico Collins", "Rashee Rice", "DeVonta Smith", "Malik Nabers", "Tee Higgins",
"Chris Olave", "Jaylen Waddle", "Tetairoa McMillan", "Emeka Egbuka", "Zay Flowers",
"Garrett Wilson", "Luther Burden III", "Ladd McConkey", "DJ Moore", "Rome Odunze",
"Terry McLaurin", "Davante Adams", "Christian Watson", "Mike Evans", "Jameson Williams",
"Parker Washington", "Brian Thomas Jr.", "Carnell Tate", "Marvin Harrison Jr.",
"Jordyn Tyson", "Alec Pierce", "Michael Wilson", "Chris Godwin Jr.", "DK Metcalf",
"Courtland Sutton", "Deebo Samuel Sr.", "Makai Lemon", "Quentin Johnston", "Josh Downs",
"Stefon Diggs", "Michael Pittman Jr.", "Jordan Addison", "Jayden Reed", "Jakobi Meyers",
"Romeo Doubs", "Matthew Golden", "De'Zhaun Stribling", "Xavier Worthy", "KC Concepcion",
"Jayden Higgins", "Travis Hunter", "Tre Tucker", "Wan'Dale Robinson", "Rashid Shaheed",
"Jalen Coker", "Adonai Mitchell", "Khalil Shakir", "Jalen Nailor", "Jauan Jennings",
"Denzel Boston", "Jalen McMillan", "Kayshon Boutte", "Tre' Harris", "Rashod Bateman",
"Calvin Ridley", "Omar Cooper Jr.", "Ryan Flournoy", "Tyreek Hill", "Jerry Jeudy"]

JOEL_TE = ["Brock Bowers", "Trey McBride", "Colston Loveland", "Tyler Warren",
"Sam LaPorta", "Harold Fannin Jr.", "Tucker Kraft", "Kyle Pitts Sr.", "George Kittle",
"Dalton Kincaid", "Dallas Goedert", "Mark Andrews", "Isaiah Likely", "Jake Ferguson",
"Travis Kelce", "Oronde Gadsden II", "Chig Okonkwo", "T.J. Hockenson", "Kenyon Sadiq",
"Terrance Ferguson", "Greg Dulcich", "Juwan Johnson", "Hunter Henry", "Brenton Strange",
"AJ Barner", "Colby Parkinson", "Dalton Schultz", "Cade Otton", "Eli Stowers",
"Pat Freiermuth", "Gunnar Helm", "Tyler Higbee", "Darnell Washington", "Evan Engram",
"David Njoku", "Jake Tonges"]

FP_QB = ["Josh Allen", "Lamar Jackson", "Drake Maye", "Jayden Daniels", "Joe Burrow",
"Jalen Hurts", "Caleb Williams", "Justin Herbert", "Trevor Lawrence", "Dak Prescott",
"Brock Purdy", "Jaxson Dart", "Bo Nix", "Patrick Mahomes II", "Kyler Murray",
"Jared Goff", "Matthew Stafford", "Tyler Shough", "Jordan Love", "Malik Willis",
"Baker Mayfield", "Sam Darnold", "Daniel Jones", "C.J. Stroud", "Cam Ward",
"Bryce Young", "Jacoby Brissett", "Fernando Mendoza", "Aaron Rodgers", "Geno Smith",
"Michael Penix Jr.", "Shedeur Sanders", "Tua Tagovailoa", "Deshaun Watson",
"Kirk Cousins", "Carson Beck", "Justin Fields", "J.J. McCarthy", "Mac Jones",
"Joe Flacco", "Ty Simpson", "Marcus Mariota", "Cade Klubnik", "Jameis Winston",
"Quinn Ewers"]

FP_WR = ["Ja'Marr Chase", "Puka Nacua", "Amon-Ra St. Brown", "Jaxon Smith-Njigba",
"CeeDee Lamb", "Justin Jefferson", "Drake London", "A.J. Brown", "Nico Collins",
"George Pickens", "Malik Nabers", "DeVonta Smith", "Rashee Rice", "Chris Olave",
"Tee Higgins", "Zay Flowers", "Jaylen Waddle", "Emeka Egbuka", "Tetairoa McMillan",
"Garrett Wilson", "Ladd McConkey", "Luther Burden III", "Terry McLaurin",
"Jameson Williams", "Davante Adams", "Mike Evans", "Christian Watson", "Rome Odunze",
"DJ Moore", "Parker Washington", "Carnell Tate", "Marvin Harrison Jr.", "Jordyn Tyson",
"Brian Thomas Jr.", "DK Metcalf", "Alec Pierce", "Chris Godwin Jr.", "Quentin Johnston",
"Courtland Sutton", "Makai Lemon", "Michael Wilson", "Josh Downs", "Stefon Diggs",
"Jayden Reed", "Michael Pittman Jr.", "Jordan Addison", "Jakobi Meyers",
"Wan'Dale Robinson", "Matthew Golden", "Deebo Samuel Sr.", "Jalen Coker",
"Xavier Worthy", "KC Concepcion", "Jayden Higgins", "Romeo Doubs",
"De'Zhaun Stribling", "Khalil Shakir", "Rashid Shaheed", "Denzel Boston", "Tre Tucker",
"Jalen McMillan", "Travis Hunter", "Adonai Mitchell", "Ryan Flournoy", "Jalen Nailor",
"Omar Cooper Jr.", "Jauan Jennings", "Jerry Jeudy", "Tre' Harris", "Kayshon Boutte",
"Calvin Ridley", "Rashod Bateman", "Malik Washington", "Pat Bryant",
"Dontayvion Wicks", "Isaac TeSlaa", "Cyrus Allen", "Darnell Mooney", "Tank Dell",
"Ja'Kobi Lane", "Troy Franklin", "Antonio Williams", "Zachariah Branch", "Jaylin Noel",
"Malachi Fields", "Germie Bernard", "Tory Horton", "Caleb Douglas", "Keon Coleman",
"Cooper Kupp", "Tyquan Thornton", "Chris Bell", "Elijah Sarratt", "Elic Ayomanor",
"Darius Slayton", "Ted Hurst III", "Jack Bech", "Keenan Allen", "Tyreek Hill",
"Chimere Dike"]

FP_TE = ["Brock Bowers", "Trey McBride", "Colston Loveland", "Tyler Warren",
"Tucker Kraft", "Harold Fannin Jr.", "Sam LaPorta", "Kyle Pitts Sr.", "George Kittle",
"Dalton Kincaid", "Dallas Goedert", "Travis Kelce", "Isaiah Likely", "Mark Andrews",
"Jake Ferguson", "Chig Okonkwo", "Juwan Johnson", "Hunter Henry", "Brenton Strange",
"Oronde Gadsden II", "T.J. Hockenson", "Terrance Ferguson", "AJ Barner", "Kenyon Sadiq",
"Greg Dulcich", "Dalton Schultz", "Gunnar Helm", "Pat Freiermuth", "Cade Otton",
"Colby Parkinson", "David Njoku", "Evan Engram", "Eli Stowers", "Jake Tonges",
"Mike Gesicki", "Darnell Washington", "Theo Johnson", "Tyler Higbee", "Oscar Delp",
"Michael Mayer", "Mason Taylor", "Elijah Arroyo", "Eli Raridon", "Cole Kmet",
"Erick All Jr.", "Darren Waller", "Dawson Knox", "Justin Joly", "Noah Gray",
"Max Klare", "Charlie Kolar", "Mitchell Evans"]

FLOCK_QB = ["Josh Allen", "Lamar Jackson", "Drake Maye", "Jayden Daniels", "Joe Burrow",
"Caleb Williams", "Jalen Hurts", "Trevor Lawrence", "Justin Herbert", "Dak Prescott",
"Jaxson Dart", "Brock Purdy", "Bo Nix", "Patrick Mahomes II", "Matthew Stafford",
"Jared Goff", "Kyler Murray", "Baker Mayfield", "Tyler Shough", "Jordan Love",
"Malik Willis", "C.J. Stroud", "Sam Darnold", "Cam Ward", "Daniel Jones",
"Bryce Young", "Aaron Rodgers", "Jacoby Brissett", "Geno Smith", "Fernando Mendoza",
"Tua Tagovailoa", "Shedeur Sanders", "Deshaun Watson", "Michael Penix Jr.",
"Kirk Cousins", "Carson Beck", "Drew Allar", "Anthony Richardson Sr.",
"Jameis Winston", "Marcus Mariota", "Cade Klubnik", "J.J. McCarthy", "Mac Jones",
"Justin Fields", "Ty Simpson"]

FLOCK_RB = ["Jahmyr Gibbs", "Bijan Robinson", "Christian McCaffrey", "Jonathan Taylor",
"James Cook III", "Ashton Jeanty", "Chase Brown", "Omarion Hampton", "De'Von Achane",
"Saquon Barkley", "Kenneth Walker III", "Derrick Henry", "Jeremiyah Love",
"Breece Hall", "Kyren Williams", "Javonte Williams", "Josh Jacobs", "Cam Skattebo",
"Travis Etienne Jr.", "Bucky Irving", "Bhayshul Tuten", "David Montgomery",
"D'Andre Swift", "Quinshon Judkins", "TreVeyon Henderson", "Jadarian Price",
"Jaylen Warren", "Tony Pollard", "Rhamondre Stevenson", "Jonathon Brooks", "RJ Harvey",
"J.K. Dobbins", "Rachaad White", "Rico Dowdle", "Chuba Hubbard", "Blake Corum",
"Kyle Monangai", "Jordan Mason", "Kenny Gainwell", "Jacory Croskey-Merritt",
"Aaron Jones Sr.", "Chris Rodriguez Jr.", "Tyrone Tracy Jr.", "Woody Marks",
"Jonah Coleman", "Keaton Mitchell", "Isiah Pacheco", "Tyler Allgeier", "Tank Bigsby",
"Alvin Kamara", "Dylan Sampson", "Zach Charbonnet", "Tyjae Spears",
"Brian Robinson Jr.", "Sean Tucker", "Kaytron Allen", "Nicholas Singleton",
"Emmett Johnson", "MarShawn Lloyd", "Mike Washington Jr.", "Ray Davis",
"Demond Claiborne", "Chris Brooks", "Devin Singletary", "George Holani",
"Brashard Smith", "Braelon Allen", "Ollie Gordon II", "Jaydon Blue", "Kimani Vidal",
"Najee Harris", "Kaelon Black", "Jordan James", "Adam Randall", "Emanuel Wilson",
"Ty Johnson", "James Conner", "Samaje Perine", "Justice Hill", "DJ Giddens",
"Isaiah Davis", "Kendre Miller", "Isaac Guerendo", "Seth McGowan", "Kaleb Johnson",
"Trey Benson", "Jaylen Wright", "Devin Neal", "LeQuint Allen Jr.", "Trevor Etienne",
"Malik Davis"]

FLOCK_WR = ["Ja'Marr Chase", "Puka Nacua", "Jaxon Smith-Njigba", "Amon-Ra St. Brown",
"CeeDee Lamb", "Justin Jefferson", "Drake London", "A.J. Brown", "Nico Collins",
"Malik Nabers", "Rashee Rice", "George Pickens", "DeVonta Smith", "Chris Olave",
"Zay Flowers", "Tee Higgins", "Jaylen Waddle", "Emeka Egbuka", "Ladd McConkey",
"Tetairoa McMillan", "Garrett Wilson", "Davante Adams", "Terry McLaurin",
"Jameson Williams", "Luther Burden III", "Mike Evans", "Carnell Tate", "Rome Odunze",
"Brian Thomas Jr.", "DJ Moore", "Christian Watson", "Marvin Harrison Jr.",
"Jordyn Tyson", "Parker Washington", "Makai Lemon", "Quentin Johnston", "Alec Pierce",
"Jordan Addison", "DK Metcalf", "Michael Pittman Jr.", "Chris Godwin Jr.",
"Courtland Sutton", "Michael Wilson", "Josh Downs", "Stefon Diggs",
"Wan'Dale Robinson", "KC Concepcion", "Jayden Reed", "Xavier Worthy",
"Deebo Samuel Sr.", "Jakobi Meyers", "Matthew Golden", "Travis Hunter", "Romeo Doubs",
"Jalen Coker", "Jayden Higgins", "Khalil Shakir", "Rashid Shaheed", "Omar Cooper Jr.",
"Denzel Boston", "Jalen McMillan", "De'Zhaun Stribling", "Tre Tucker",
"Jauan Jennings", "Jalen Nailor", "Tre' Harris", "Antonio Williams", "Darnell Mooney",
"Adonai Mitchell", "Calvin Ridley", "Ryan Flournoy", "Malik Washington", "Tank Dell",
"Jerry Jeudy", "Dontayvion Wicks", "Zachariah Branch", "Isaac TeSlaa",
"Germie Bernard", "Elijah Sarratt", "Kayshon Boutte", "Chris Bell", "Brandon Aiyuk",
"Jaylin Noel", "Troy Franklin", "Cooper Kupp", "Pat Bryant", "Ja'Kobi Lane",
"Ted Hurst III", "Elic Ayomanor", "Keenan Allen", "Darius Slayton",
"Calvin Austin III", "Malachi Fields", "Luke McCaffrey", "Chimere Dike",
"Keon Coleman", "Cyrus Allen", "Jack Bech", "Tory Horton", "Kendrick Bourne",
"Christian Kirk", "Tez Johnson", "Bryce Lance", "Tyreek Hill"]

FLOCK_TE = ["Brock Bowers", "Trey McBride", "Colston Loveland", "Tyler Warren",
"Tucker Kraft", "Sam LaPorta", "Harold Fannin Jr.", "Kyle Pitts Sr.", "George Kittle",
"Travis Kelce", "Jake Ferguson", "Isaiah Likely", "Mark Andrews", "Dalton Kincaid",
"Dallas Goedert", "Oronde Gadsden II", "Chig Okonkwo", "Brenton Strange",
"Hunter Henry", "Kenyon Sadiq", "T.J. Hockenson", "AJ Barner", "Juwan Johnson",
"Dalton Schultz", "Greg Dulcich", "Dawson Knox", "Gunnar Helm", "Mason Taylor",
"Terrance Ferguson", "David Njoku", "Elijah Arroyo", "Pat Freiermuth", "Cole Kmet",
"Mike Gesicki", "Cade Otton", "Eli Stowers", "Ja'Tavion Sanders", "Darnell Washington",
"Evan Engram", "Colby Parkinson", "Justin Joly", "Max Klare", "Michael Mayer",
"Noah Gray", "Eli Raridon", "Jake Tonges", "Erick All Jr.", "Charlie Kolar",
"Noah Fant", "Luke Musgrave", "Theo Johnson", "Oscar Delp", "Luke Schoonmaker"]

FB_QB = ["Josh Allen", "Lamar Jackson", "Jalen Hurts", "Jayden Daniels", "Joe Burrow",
"Drake Maye", "Jaxson Dart", "Trevor Lawrence", "Caleb Williams", "Dak Prescott",
"Justin Herbert", "Bo Nix", "Brock Purdy", "Tyler Shough", "Jared Goff",
"Matthew Stafford", "Baker Mayfield", "Patrick Mahomes II", "Kyler Murray",
"Malik Willis", "Jordan Love", "Cam Ward", "C.J. Stroud", "Sam Darnold",
"Daniel Jones", "Bryce Young", "Aaron Rodgers", "Jacoby Brissett", "Geno Smith",
"Shedeur Sanders", "Tua Tagovailoa", "Kirk Cousins", "Fernando Mendoza",
"Michael Penix Jr.", "Carson Beck", "Deshaun Watson"]

FB_RB = ["Jahmyr Gibbs", "Bijan Robinson", "Christian McCaffrey", "James Cook III",
"Jonathan Taylor", "De'Von Achane", "Kenneth Walker III", "Ashton Jeanty",
"Derrick Henry", "Chase Brown", "Omarion Hampton", "Saquon Barkley", "Josh Jacobs",
"Jeremiyah Love", "Kyren Williams", "Cam Skattebo", "Breece Hall", "Javonte Williams",
"Bucky Irving", "D'Andre Swift", "Bhayshul Tuten", "Travis Etienne Jr.",
"TreVeyon Henderson", "Quinshon Judkins", "David Montgomery", "Jadarian Price",
"Jacory Croskey-Merritt", "Chuba Hubbard", "Rico Dowdle", "Rhamondre Stevenson",
"Jaylen Warren", "J.K. Dobbins", "Tony Pollard", "Kenny Gainwell", "Kyle Monangai",
"Jordan Mason", "Blake Corum", "RJ Harvey", "Rachaad White", "Tyrone Tracy Jr.",
"Aaron Jones Sr.", "Jonathon Brooks", "Tyjae Spears", "Woody Marks",
"Chris Rodriguez Jr.", "Isiah Pacheco", "Zach Charbonnet", "Keaton Mitchell",
"Dylan Sampson", "Tank Bigsby", "Jonah Coleman", "Alvin Kamara", "Brian Robinson Jr.",
"Tyler Allgeier", "Kimani Vidal", "Jordan James", "Justice Hill", "Emmett Johnson",
"Samaje Perine", "Mike Washington Jr.", "Nicholas Singleton", "Ty Johnson",
"MarShawn Lloyd", "James Conner", "Braelon Allen", "Chris Brooks", "DJ Giddens",
"Isaiah Davis", "Kaelon Black", "Jerome Ford", "Ray Davis", "Sean Tucker",
"Jaylen Wright", "Devin Neal", "George Holani", "LeQuint Allen Jr.", "Brashard Smith",
"Devin Singletary", "Emanuel Wilson", "Jaydon Blue", "Kaytron Allen",
"Demond Claiborne", "Trevor Etienne", "Emari Demercado", "Ollie Gordon II",
"Kaleb Johnson", "Will Shipley", "Adam Randall", "Tahj Brooks", "AJ Dillon",
"Audric Estime"]

FB_WR = ["Ja'Marr Chase", "Puka Nacua", "Jaxon Smith-Njigba", "Amon-Ra St. Brown",
"CeeDee Lamb", "Drake London", "Justin Jefferson", "A.J. Brown", "Chris Olave",
"George Pickens", "Nico Collins", "Malik Nabers", "Garrett Wilson", "Rashee Rice",
"Emeka Egbuka", "Zay Flowers", "Jaylen Waddle", "DeVonta Smith",
"Tetairoa McMillan", "Tee Higgins", "Ladd McConkey", "Christian Watson",
"Carnell Tate", "Jameson Williams", "Luther Burden III", "Alec Pierce", "DJ Moore",
"Davante Adams", "Mike Evans", "Terry McLaurin", "Parker Washington", "Rome Odunze",
"DK Metcalf", "Brian Thomas Jr.", "Marvin Harrison Jr.", "Quentin Johnston",
"Jordyn Tyson", "Michael Pittman Jr.", "Chris Godwin Jr.", "Jordan Addison",
"Michael Wilson", "Courtland Sutton", "Josh Downs", "Stefon Diggs",
"Wan'Dale Robinson", "Jayden Reed", "Makai Lemon", "Jayden Higgins", "Xavier Worthy",
"Deebo Samuel Sr.", "Romeo Doubs", "Jakobi Meyers", "Jalen Coker", "Rashid Shaheed",
"Khalil Shakir", "Matthew Golden", "KC Concepcion", "Malik Washington", "Tre Tucker",
"Omar Cooper Jr.", "De'Zhaun Stribling", "Jalen Nailor", "Jerry Jeudy",
"Denzel Boston", "Travis Hunter", "Cooper Kupp", "Adonai Mitchell", "Calvin Ridley",
"Germie Bernard", "Ja'Kobi Lane", "Keon Coleman", "DeMario Douglas",
"Dontayvion Wicks", "Ryan Flournoy", "Tre' Harris", "Jalen McMillan",
"Kayshon Boutte", "Zachariah Branch", "Caleb Douglas", "Darius Slayton", "Tank Dell",
"Isaac TeSlaa", "Jauan Jennings", "Cyrus Allen", "Rashod Bateman", "Tory Horton",
"Pat Bryant", "Ted Hurst III", "Antonio Williams", "Jalen Tolbert", "Jack Bech",
"Troy Franklin", "Devaughn Vele", "Darnell Mooney", "Chris Bell", "Malachi Fields",
"Andrei Iosivas", "Elic Ayomanor", "Tyquan Thornton", "Chimere Dike"]

FB_TE = ["Brock Bowers", "Trey McBride", "Colston Loveland", "Tyler Warren",
"Harold Fannin Jr.", "Tucker Kraft", "George Kittle", "Sam LaPorta", "Kyle Pitts Sr.",
"Dalton Kincaid", "Travis Kelce", "Dallas Goedert", "Brenton Strange",
"Isaiah Likely", "Jake Ferguson", "Hunter Henry", "Mark Andrews", "Dalton Schultz",
"Chig Okonkwo", "Juwan Johnson", "Greg Dulcich", "Kenyon Sadiq", "T.J. Hockenson",
"Pat Freiermuth", "Oronde Gadsden II", "Cade Otton", "AJ Barner", "Colby Parkinson",
"David Njoku", "Mike Gesicki", "Cole Kmet", "Evan Engram", "Gunnar Helm",
"Terrance Ferguson", "Dawson Knox", "Mason Taylor", "Eli Stowers", "Michael Mayer",
"Ja'Tavion Sanders", "Luke Musgrave", "Charlie Kolar", "Theo Johnson",
"Elijah Arroyo", "Noah Gray", "Tommy Tremble", "Darnell Washington", "Ben Sinnott",
"Max Klare", "Jake Tonges", "Justin Joly", "Noah Fant", "Nate Boerkircher",
"Oscar Delp"]

SOURCES = {
    "QB": {"joel": JOEL_QB, "fp": FP_QB, "flock": FLOCK_QB, "fb": FB_QB},
    "RB": {"joel": JOEL_RB, "flock": FLOCK_RB, "fb": FB_RB},  # FP RB paste was a QB dup
    "WR": {"joel": JOEL_WR, "fp": FP_WR, "flock": FLOCK_WR, "fb": FB_WR},
    "TE": {"joel": JOEL_TE, "fp": FP_TE, "flock": FLOCK_TE, "fb": FB_TE},
}

out = {}
for pos, srcs in SOURCES.items():
    ranks = {}
    for src, names in srcs.items():
        seen = set()
        r = 0
        for name in names:
            if name in seen:
                continue  # duplicate rows in a source (e.g. Flock's Eli Stowers)
            seen.add(name)
            r += 1
            ranks.setdefault(name, {})[src] = r
    out[pos] = [
        {"name": name, "avg": round(sum(rr.values()) / len(rr), 2),
         "n": len(rr), "ranks": rr}
        for name, rr in ranks.items()
    ]
    out[pos].sort(key=lambda x: x["avg"])
    print(f"{pos}: {len(out[pos])} players from {len(srcs)} sources; "
          f"top 3: {[x['name'] for x in out[pos][:3]]}")

dest = Path(__file__).parent / "data" / "consensus_ranks.json"
dest.parent.mkdir(exist_ok=True)
dest.write_text(json.dumps(out, indent=1), encoding="utf-8")
print(f"wrote {dest}")
