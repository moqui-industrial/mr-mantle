// This software is in the public domain under CC0 1.0 Universal plus a
// Grant of Patent License.
//
// To the extent possible under law, the author(s) have dedicated all
// copyright and related and neighboring rights to this software to the
// public domain worldwide. This software is distributed without any
// warranty.
//
// You should have received a copy of the CC0 Public Domain Dedication
// along with this software (see the LICENSE.md file). If not, see
// <http://creativecommons.org/publicdomain/zero/1.0/>.

// The X12 4010 grammar of transaction set 997 for EdiHandler (plan/payments-shipping-edi.md E1), converted from the Java
// Moqui mantle-edi component (github.com/moqui/mantle-edi, 1.1.5, commit 134acb6, service/mantle/edi/.../X12V4010TS997.groovy):
// the Bots grammar list of {ID, MIN, MAX, LEVEL}, which the framework's parser checks for order and occurrences. The file
// evaluates to the list.
// prettier-ignore
;[
{ID: 'ST', MIN: 1, MAX: 1, LEVEL: [
    {ID: 'AK1', MIN: 1, MAX: 1},
    {ID: 'AK2', MIN: 0, MAX: 999999, LEVEL: [
        {ID: 'AK3', MIN: 0, MAX: 999999, LEVEL: [
            {ID: 'AK4', MIN: 0, MAX: 99},
        ]},
        {ID: 'AK5', MIN: 1, MAX: 1},
    ]},
    {ID: 'AK9', MIN: 1, MAX: 1},
    {ID: 'SE', MIN: 1, MAX: 1},
]}
]
